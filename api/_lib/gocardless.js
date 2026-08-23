const { GoCardlessClient, Environments } = require('gocardless-nodejs');
const crypto = require('crypto');

// Server-side only — never import this file from anything that ships to
// the browser. Mirrors the getSupabase() pattern: lazily build the client
// from env vars, throw clearly if they're missing.
//
// GC_ACCESS_TOKEN        - access token for the GoCardless account
// GC_ENVIRONMENT         - "sandbox" or "live" (defaults to sandbox so a
//                           missing env var can never accidentally hit live)
// GC_WEBHOOK_SECRET       - the webhook endpoint secret from the GoCardless
//                           dashboard, used to verify inbound webhook signatures
function getGoCardlessClient() {
  const token = process.env.GC_ACCESS_TOKEN;
  if (!token) {
    throw new Error('Missing GC_ACCESS_TOKEN env var');
  }
  const env = process.env.GC_ENVIRONMENT === 'live' ? Environments.Live : Environments.Sandbox;
  return new GoCardlessClient(token, env);
}

// Membership tier monthly prices, in pence. Kept here (server-side) as the
// source of truth for subscription amounts — never trust a price sent from
// the client.
//
// Only Core and Resident actually have a flat monthly fee — confirmed
// against the real booking/pricing logic (api/bookings.js,
// isIncludedInMembershipFee): Flex has no "included slot" concept at all,
// every single Flex booking is charged individually. flex: 9900 here used
// to be a leftover placeholder from an early scaffold written before that
// was clarified, and was never removed — left live, it would have started
// an EXTRA £99/month subscription on top of a Flex member's legitimate
// per-session charges the moment their mandate went active. Found and
// fixed during the pre-launch UI/UX review, before any real Flex mandate
// had gone active.
const PLAN_TIER_MONTHLY_PENCE = {
  community: null, // pay-as-you-go, no recurring subscription
  flex: null,       // pay-as-you-go per session, no recurring subscription
  core: 24900,
  resident: 44900,
};

// Reads the raw, unparsed request body as a string. Needed for webhook
// signature verification, which must hash the exact bytes GoCardless sent —
// re-serializing a parsed req.body with JSON.stringify can produce different
// bytes (key order, spacing) and silently break verification. Callers must
// disable Vercel's default body parsing for the route (see webhooks/gocardless.js).
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Builds the `links` object for a Billing Request create call. Returns
// undefined (omit `links` entirely) when the member has no GoCardless
// customer yet, rather than calling `client.customers.create()` first.
//
// That direct Customer:Create call is what used to live here (as
// getOrCreateCustomer) — and it's exactly the endpoint GoCardless's live
// environment restricts unless your payment pages are scheme-rules
// approved (confirmed by GoCardless support, ticket #4423820, after our
// mandate setup started 403ing on live: "the 403 error you are getting is
// due to the POST /Customer endpoint being restricted via the API... start
// the flow by creating a billing request [and] you can call the
// collect_customer_details action to create a customer"). Omitting `links`
// on Billing Request creation makes GoCardless create a blank customer as
// part of that (unrestricted) call instead — see persistNewCustomerId below
// for picking its id up afterwards.
function customerLinksFor(member) {
  return member.gocardless_customer_id ? { customer: member.gocardless_customer_id } : undefined;
}

// After creating a Billing Request for a member with no gocardless_customer_id
// yet, GoCardless will have auto-created a blank customer as part of that
// call — its id comes back in billingRequest.resources.customer.id (see the
// gocardless-nodejs BillingRequestResourcesCustomer type). Persist it
// immediately, synchronously, right here — not just when the mandate.active
// webhook eventually arrives — because the mandate webhook handler
// (api/webhooks/gocardless.js) matches incoming events back to a member via
// `.eq('gocardless_customer_id', links.customer)`. If nothing had saved this
// yet, that lookup would find no member and silently drop every mandate
// status update for a first-time customer.
async function persistNewCustomerId(supabase, member, billingRequest) {
  if (member.gocardless_customer_id) return member.gocardless_customer_id;
  const newId = billingRequest.resources && billingRequest.resources.customer && billingRequest.resources.customer.id;
  if (!newId) return null;
  const { error } = await supabase.from('members').update({ gocardless_customer_id: newId }).eq('id', member.id);
  if (error) throw new Error(`Billing request created (customer ${newId}) but failed to save it: ${error.message}`);
  return newId;
}

// Creates a one-off Direct Debit payment against an existing active mandate
// (e.g. for a chargeable extra session). idempotencyKey should be stable per
// logical charge (we use the booking id) so a retried request never double-charges.
// NOTE: GoCardless's API takes amount as a STRING, not a number — this was
// previously sent as a raw number, which the SDK's TypeScript types reject
// (amount: string on PaymentCreateRequest) - explicitly stringify it.
async function createOneOffPayment(client, { mandateId, amountPence, description, idempotencyKey }) {
  return client.payments.create(
    { amount: String(amountPence), currency: 'GBP', links: { mandate: mandateId }, description },
    idempotencyKey || crypto.randomUUID(),
  );
}

// Creates the flat recurring monthly membership charge for Core/Resident
// tiers, against an active mandate. Call this once per member (guarded by
// checking members.gocardless_subscription_id first) — calling it twice
// would create two subscriptions and double-bill them.
async function createMembershipSubscription(client, { mandateId, amountPence, name, idempotencyKey }) {
  return client.subscriptions.create(
    { amount: String(amountPence), currency: 'GBP', name, interval_unit: 'monthly', links: { mandate: mandateId } },
    idempotencyKey || crypto.randomUUID(),
  );
}

// Idempotent: sets up a member's flat monthly membership subscription if
// they're eligible (Core/Resident, active mandate) and don't already have
// one. Shared by the webhook (fires automatically the moment a mandate goes
// active), the admin-triggered manual recovery endpoint, and the daily
// safety-net cron — so there's more than one path to actually getting this
// set up, and a single place to fix if the logic needs to change.
// Returns { skipped: true, reason } | { created: true, subscriptionId } | { failed: true, error }.
async function ensureMembershipSubscription(supabase, member) {
  // Tier eligibility is checked BEFORE applying any override — a stray
  // custom_monthly_fee_pence value on a Community/Flex member (shouldn't
  // happen given it's only ever set via the Core/Resident invite flow, but
  // worth guarding regardless) must never activate a subscription for a
  // tier that isn't supposed to have one at all.
  if (!['core', 'resident'].includes(member.plan_tier)) return { skipped: true, reason: 'not_eligible_tier' };

  // custom_monthly_fee_pence lets Staff & Admin override the standard tier
  // rate for a specific member — special negotiated deals (team review 19
  // Aug 2026: "one or two people have special deals"). Falls back to the
  // standard rate when not set.
  const monthlyPence = member.custom_monthly_fee_pence != null ? member.custom_monthly_fee_pence : PLAN_TIER_MONTHLY_PENCE[member.plan_tier];
  if (!monthlyPence) return { skipped: true, reason: 'not_eligible_tier' };
  if (member.mandate_status !== 'active' || !member.gocardless_mandate_id) return { skipped: true, reason: 'no_active_mandate' };
  if (member.gocardless_subscription_id) return { skipped: true, reason: 'already_has_subscription' };

  try {
    const client = getGoCardlessClient();
    const subscription = await createMembershipSubscription(client, {
      mandateId: member.gocardless_mandate_id,
      amountPence: monthlyPence,
      name: `Radiant ${member.plan_tier === 'resident' ? 'Resident' : 'Core'} Membership`,
      idempotencyKey: `subscription:${member.id}`,
    });
    const { error } = await supabase.from('members').update({ gocardless_subscription_id: subscription.id }).eq('id', member.id);
    if (error) return { failed: true, error: `Subscription ${subscription.id} created at GoCardless but failed to save locally: ${error.message}` };
    return { created: true, subscriptionId: subscription.id, amountPence: monthlyPence };
  } catch (e) {
    const detail = (e.errors && e.errors.length) ? e.errors.map(x => [x.field, x.message || x.reason].filter(Boolean).join(': ')).join('; ') : e.message;
    return { failed: true, error: detail };
  }
}

module.exports = { getGoCardlessClient, PLAN_TIER_MONTHLY_PENCE, readRawBody, createOneOffPayment, createMembershipSubscription, customerLinksFor, persistNewCustomerId, ensureMembershipSubscription, handleMandateBecameActive, reconcileMemberMandate };

// Everything that should happen the moment a mandate is confirmed active —
// extracted from api/webhooks/gocardless.js so this exact logic can also
// run from api/billing/sync-mandate.js. That second caller exists because,
// found live: every mandate ever attempted across a month of testing sat
// stuck at pending_submission forever, gocardless_mandate_id never set —
// the mandate lifecycle webhook has never once been successfully processed
// in production. Reconciling directly against GoCardless (rather than only
// ever waiting on that webhook) needed to trigger the exact same emails and
// subscription setup the webhook would have, not a second, drifting copy
// of this logic.
async function handleMandateBecameActive(supabase, member) {
  const { sendMandateActiveEmail, sendSubscriptionStartedEmail } = require('./email');
  const { logAudit } = require('./audit');
  const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;

  try {
    await sendMandateActiveEmail({ to: member.email, memberName });
  } catch (e) {
    console.error(`Failed to send mandate-active email to member ${member.id}:`, e.message);
  }

  // Core/Resident have a flat monthly membership fee on top of any
  // per-session charges (confirmed by Radiant) — set up the recurring
  // subscription the moment their mandate goes active. Idempotent, so
  // calling this from both the webhook and a manual sync is safe even if
  // both somehow ran for the same member.
  const result = await ensureMembershipSubscription(supabase, member);
  if (result.created) {
    await logAudit({
      actorId: null, actorName: 'GoCardless', action: 'billing.subscription_created',
      entityType: 'member', entityId: member.id, details: { subscription_id: result.subscriptionId },
    });
    try {
      const tierLabel = member.plan_tier === 'resident' ? 'Resident' : 'Core';
      // Real bug found in a proactive audit (22 Aug, after Saad flagged
      // worry about side effects from tonight's fixes): this used to read
      // PLAN_TIER_MONTHLY_PENCE[member.plan_tier] directly, ignoring any
      // custom_monthly_fee_pence override — so a member on a negotiated
      // special-deal rate would be charged correctly (ensureMembership
      // Subscription already respected the override) but told the wrong,
      // standard amount in this email. result.amountPence is the actual
      // figure that was charged, override or not.
      await sendSubscriptionStartedEmail({ to: member.email, memberName, tierLabel, amountPence: result.amountPence });
    } catch (e) {
      console.error(`Failed to send subscription-started email to member ${member.id}:`, e.message);
    }
  } else if (result.failed) {
    console.error(`Failed to create membership subscription for member ${member.id}:`, result.error);
    await logAudit({
      actorId: null, actorName: 'GoCardless', action: 'billing.subscription_creation_failed',
      entityType: 'member', entityId: member.id, details: { error: result.error },
    });
    const { data: admins } = await supabase.from('members').select('id').eq('user_type', 'administrator').eq('status', 'active');
    for (const admin of admins || []) {
      await supabase.from('messages').insert({
        sender_id: member.id, recipient_id: admin.id,
        body: `⚠ Failed to set up ${memberName}'s monthly membership subscription after their Direct Debit went active (${result.error}). Their recurring slot fee won't be collected until this is fixed — use 'Create subscription now' in Manage Member, or check the GoCardless dashboard directly.`,
      });
    }
  }
}

// Core reconciliation logic, extracted so the admin "Sync with GoCardless"
// button and the hourly cron (api/cron/sync-mandates.js) both call the
// exact same thing rather than risking two copies drifting apart. Queries
// GoCardless directly for one member's real mandate state and updates our
// record to match — this exists because the mandate lifecycle webhook has
// never once been successfully processed in production (found 22 Aug 2026,
// every mandate ever attempted sat stuck at pending_submission forever).
// Returns { ok, changed, previous_status, new_status } or
// { ok, changed: false, billing_request_status, message } when nothing's
// progressed yet, or throws on a genuine GoCardless/DB error — callers
// decide how to report that (an HTTP error for the admin endpoint, a
// logged failure for the cron).
async function reconcileMemberMandate(supabase, member) {
  if (!member.gocardless_billing_request_id && !member.gocardless_mandate_id) {
    return { ok: false, error: 'No Direct Debit setup on record to sync.' };
  }

  const client = getGoCardlessClient();
  let mandateId = null;
  let mandateStatus = null;

  if (member.gocardless_mandate_id) {
    const mandate = await client.mandates.find(member.gocardless_mandate_id);
    mandateId = mandate.id;
    mandateStatus = mandate.status;
  } else {
    // No mandate id on record yet — the only lead is the Billing Request
    // that started the flow. If GoCardless has since linked a mandate to
    // it (mandate_request_mandate), that's the mandate that was actually
    // created; if not, the Billing Request itself hasn't progressed and
    // there's genuinely nothing further to sync yet.
    const billingRequest = await client.billingRequests.find(member.gocardless_billing_request_id);
    const linkedMandateId = billingRequest.links && billingRequest.links.mandate_request_mandate;
    if (!linkedMandateId) {
      return {
        ok: true, changed: false,
        billing_request_status: billingRequest.status,
        message: `Billing Request still "${billingRequest.status}" — no mandate created from it yet.`,
      };
    }
    const mandate = await client.mandates.find(linkedMandateId);
    mandateId = mandate.id;
    mandateStatus = mandate.status;
  }

  // GoCardless's Mandate.status values map 1:1 onto what members.
  // mandate_status allows (see the migration that extended its CHECK
  // constraint alongside this) — no translation needed, just guard against
  // an unrecognised value rather than writing it blindly if GoCardless
  // ever adds a new one.
  const knownStatuses = ['pending_customer_approval', 'pending_submission', 'submitted', 'active', 'cancelled', 'failed', 'expired', 'consumed', 'blocked', 'suspended_by_payer'];
  if (!knownStatuses.includes(mandateStatus)) {
    throw new Error(`GoCardless returned an unrecognised mandate status: "${mandateStatus}"`);
  }

  const previousStatus = member.mandate_status;
  const wasActive = previousStatus === 'active';
  const nowActive = mandateStatus === 'active';

  const updates = { mandate_status: mandateStatus };
  if (mandateId) updates.gocardless_mandate_id = mandateId;

  const { data: updated, error: updateErr } = await supabase
    .from('members')
    .update(updates)
    .eq('id', member.id)
    .select('*')
    .single();
  if (updateErr) throw new Error(updateErr.message);

  // Only run the "just went active" side effects (email + subscription
  // setup) if this sync is what's newly discovering that — not on every
  // sync of an already-active mandate. handleMandateBecameActive is
  // idempotent regardless, but there's no reason to call it or resend the
  // email needlessly.
  if (nowActive && !wasActive) {
    await handleMandateBecameActive(supabase, updated);
  }

  return { ok: true, changed: previousStatus !== mandateStatus, previous_status: previousStatus, new_status: mandateStatus, mandate_id: mandateId };
}
