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
//
// SUPERSEDED for Core/Resident by calculateScheduleBasedMonthlyFeePence()
// below (team review 26 Aug 2026 — a flat £249/£449 regardless of the
// agreed schedule was wrong; the fee should scale with what was actually
// agreed). Left defined here only as the last-resort fallback for the
// edge case of a Core/Resident member with literally zero recurring slots
// on record — should never happen in practice (a slot is required at
// invite time), but a fallback beats a $NaN subscription amount.
const PLAN_TIER_MONTHLY_PENCE = {
  community: null, // pay-as-you-go, no recurring subscription
  flex: null,       // pay-as-you-go per session, no recurring subscription
  core: 24900,
  resident: 44900,
};

// Per-slot weekly rates, in pence, mirrored from the same brochure figures
// already shown on Membership & Pricing (index.html's TIER_DATA) — that
// page's "Half Day (50%)" row is the half-day/week rate, and "1 Day/Week"
// is the full-day/week rate (confirmed earlier: 1 Day/Week is always
// exactly double Half Day, e.g. Resident Clinical £80 = 2×£40, matching
// "a fixed rate per half-day slot and a separate rate per full-day slot,
// added up" — team review 26 Aug 2026). Kept here, not derived from
// TIER_DATA, since that lives in client-shipped index.html and the actual
// GoCardless subscription amount must never trust anything client-side.
const WEEKLY_SLOT_RATES_PENCE = {
  core:     { half: { clinical_wellness: 4250, consultation: 3500 }, full: { clinical_wellness: 8500, consultation: 7000 } },
  resident: { half: { clinical_wellness: 4000, consultation: 3250 }, full: { clinical_wellness: 8000, consultation: 6500 } },
};
const WEEKS_PER_MONTH = 52 / 12; // 4.3333... — the standard, mathematically fair weekly-to-monthly conversion (a flat ×4 would quietly undercharge every year, since 52 weeks don't divide evenly into 12 months of exactly 4 weeks each).

// The real, schedule-based monthly fee for a Core/Resident member — team
// review 26 Aug 2026: "residents and core can only have full or half
// days... a fixed rate per half-day slot and a separate rate per full-day
// slot, added up" for the MONTHLY charge specifically (not the earlier,
// separate half/full-day booking-length rule already enforced at slot
// creation time). Fetches the member's actual agreed slots directly
// rather than trusting anything already attached to the passed `member`
// object, since recurring_slots is only ever attached by /api/me for the
// logged-in user's own record — callers like the webhook or cron pass a
// bare members-table row without it.
async function calculateScheduleBasedMonthlyFeePence(supabase, member) {
  if (!['core', 'resident'].includes(member.plan_tier)) return null;

  const { data: slots, error } = await supabase
    .from('member_recurring_slots')
    .select('time_start, time_end, interval_weeks, room:rooms(pricing_category)')
    .eq('member_id', member.id);
  if (error || !slots || slots.length === 0) {
    // Fallback for the edge case of a Core/Resident member with no
    // recurring slot on record at all (shouldn't happen — one is required
    // at invite time — but a flat fallback beats a zero/NaN subscription).
    return PLAN_TIER_MONTHLY_PENCE[member.plan_tier];
  }

  const rates = WEEKLY_SLOT_RATES_PENCE[member.plan_tier];
  let weeklyTotalPence = 0;
  for (const slot of slots) {
    const [startH, startM] = slot.time_start.split(':').map(Number);
    const [endH, endM] = slot.time_end.split(':').map(Number);
    const durationHours = (endH * 60 + endM - (startH * 60 + startM)) / 60;
    const lengthKey = durationHours >= 8 ? 'full' : 'half'; // matches the half/full-day-only rule already enforced at slot creation (api/recurring-slots.js, api/invites.js)
    const categoryKey = (slot.room && slot.room.pricing_category === 'consultation') ? 'consultation' : 'clinical_wellness';
    // Team review 26 Aug 2026: "yes — half price" for a fortnightly slot,
    // generalised to every N weeks — a slot used a third as often (every
    // 3rd week) costs a third of the weekly rate, straightforwardly.
    weeklyTotalPence += rates[lengthKey][categoryKey] / (slot.interval_weeks || 1);
  }
  return Math.round(weeklyTotalPence * WEEKS_PER_MONTH);
}

// Full outstanding-balance calculation at cancellation (team review 26
// Aug 2026: "on practitioner cancellation we collect any underpayment...
// everything outstanding on the account, combined into one figure").
// Two genuinely different things added together:
//
// 1. The monthly-averaging shortfall — only meaningful because the real
//    monthly charge is a flat weekly-rate average (WEEKS_PER_MONTH above),
//    not a literal count of that month's actual session dates. Someone
//    who leaves partway through a billing cycle may have used slightly
//    more (or less) than they've been charged for so far; this compares
//    what they SHOULD have paid by now (weekly rate × weeks elapsed since
//    plan_tier_started_at, or their custom override pro-rated the same
//    way) against what GoCardless has actually collected via their
//    subscription to date. Only ever returns a POSITIVE shortfall — if
//    the maths comes out negative (they've technically overpaid), that's
//    a refund question for a human to decide on, not something this
//    automatically nets off.
// 2. Any other genuinely unpaid booking on the account — a failed or
//    still-pending session charge that has nothing to do with the
//    membership fee itself (team review: "everything outstanding on the
//    account, combined into one figure", not just the averaging part).
//
// Deliberately calculation-only — never creates a charge itself. Admin
// reviews the number in Manage Member and clicks to actually collect it
// (team review: "calculate it and show admin the amount, admin clicks to
// actually collect it") — see api/billing/collect-final-balance.js.
async function calculateOutstandingBalanceAtCancellation(supabase, member) {
  const breakdown = { averaging_shortfall_pence: 0, other_unpaid_pence: 0 };

  if (['core', 'resident'].includes(member.plan_tier) && member.plan_tier_started_at) {
    let weeklyEquivalentPence;
    if (member.custom_monthly_fee_pence != null) {
      weeklyEquivalentPence = member.custom_monthly_fee_pence / WEEKS_PER_MONTH;
    } else {
      const { data: slots } = await supabase
        .from('member_recurring_slots')
        .select('time_start, time_end, interval_weeks, room:rooms(pricing_category)')
        .eq('member_id', member.id);
      const rates = WEEKLY_SLOT_RATES_PENCE[member.plan_tier];
      weeklyEquivalentPence = 0;
      for (const slot of slots || []) {
        const [startH, startM] = slot.time_start.split(':').map(Number);
        const [endH, endM] = slot.time_end.split(':').map(Number);
        const durationHours = (endH * 60 + endM - (startH * 60 + startM)) / 60;
        const lengthKey = durationHours >= 8 ? 'full' : 'half';
        const categoryKey = (slot.room && slot.room.pricing_category === 'consultation') ? 'consultation' : 'clinical_wellness';
        weeklyEquivalentPence += rates[lengthKey][categoryKey] / (slot.interval_weeks || 1);
      }
    }

    const weeksElapsed = (new Date() - new Date(member.plan_tier_started_at)) / (7 * 24 * 3600 * 1000);
    const expectedToDatePence = weeklyEquivalentPence * weeksElapsed;

    let actuallyCollectedPence = 0;
    if (member.gocardless_subscription_id) {
      try {
        const client = getGoCardlessClient();
        const { payments } = await client.payments.list({ subscription: member.gocardless_subscription_id });
        actuallyCollectedPence = (payments || [])
          .filter(p => ['confirmed', 'paid_out'].includes(p.status))
          .reduce((sum, p) => sum + Number(p.amount), 0);
      } catch (e) {
        // If GoCardless can't be reached, safer to show no shortfall than
        // a wrong one built on missing data — admin can retry later.
        actuallyCollectedPence = expectedToDatePence;
      }
    }

    // Team review (26 Aug follow-up): "what do we do on exit if over or
    // under" — the raw difference is preserved here (not clamped to zero
    // until the very next line) specifically so an overpayment is visible
    // to admin rather than silently discarded. This never triggers a
    // refund automatically — same "a human decides" principle as the
    // shortfall side — it just means admin sees the full picture on
    // cancellation instead of a misleading "nothing outstanding" when
    // someone is actually owed money back.
    const rawDifferencePence = Math.round(expectedToDatePence - actuallyCollectedPence);
    breakdown.averaging_raw_difference_pence = rawDifferencePence;
    breakdown.averaging_shortfall_pence = Math.max(0, rawDifferencePence);
  }

  const { data: unpaidBookings } = await supabase
    .from('bookings')
    .select('amount_pence')
    .eq('member_id', member.id)
    .in('payment_status', ['pending', 'failed'])
    .neq('status', 'cancelled');
  breakdown.other_unpaid_pence = (unpaidBookings || []).reduce((sum, b) => sum + (b.amount_pence || 0), 0);

  breakdown.total_pence = breakdown.averaging_shortfall_pence + breakdown.other_unpaid_pence;
  return breakdown;
}

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
  // real schedule-based rate (not a flat tier rate) when not set.
  const monthlyPence = member.custom_monthly_fee_pence != null ? member.custom_monthly_fee_pence : await calculateScheduleBasedMonthlyFeePence(supabase, member);
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

module.exports = { getGoCardlessClient, PLAN_TIER_MONTHLY_PENCE, readRawBody, createOneOffPayment, createMembershipSubscription, customerLinksFor, persistNewCustomerId, ensureMembershipSubscription, handleMandateBecameActive, reconcileMemberMandate, calculateScheduleBasedMonthlyFeePence, calculateOutstandingBalanceAtCancellation, calculateFeeBreakdown };

// Team review: "so they see exactly how they are billed" — genuinely
// dynamic, built from whichever real slots are passed in, not a
// generic/example explanation. Mirrors the client-side
// calculateFeeBreakdownDisplay in index.html exactly (same rates, same
// >=8hr threshold, same ÷interval_weeks, same ×WEEKS_PER_MONTH) — used
// by the invite email (api/_lib/email.js) so what someone reads before
// ever clicking "Accept" matches, line for line, what they'll see again
// on the onboarding Room Offer screen.
function calculateFeeBreakdown(tier, slots) {
  if (!slots || slots.length === 0) return null;
  const rates = WEEKLY_SLOT_RATES_PENCE[tier];
  if (!rates) return null;
  const lines = [];
  let weeklyTotalPence = 0;
  for (const slot of slots) {
    const [startH, startM] = slot.time_start.split(':').map(Number);
    const [endH, endM] = slot.time_end.split(':').map(Number);
    const durationHours = (endH * 60 + endM - (startH * 60 + startM)) / 60;
    const lengthKey = durationHours >= 8 ? 'full' : 'half';
    const categoryKey = slot.pricing_category === 'consultation' ? 'consultation' : 'clinical_wellness';
    const ratePence = rates[lengthKey][categoryKey];
    const intervalWeeks = slot.interval_weeks || 1;
    const weeklyPence = ratePence / intervalWeeks;
    weeklyTotalPence += weeklyPence;
    const durationLabel = lengthKey === 'full' ? 'Full day' : 'Half day';
    const roomLabel = slot.room_name || (categoryKey === 'consultation' ? 'Consultation' : 'Clinical/Wellness');
    const freqLabel = intervalWeeks > 1 ? `, every ${intervalWeeks} weeks` : '';
    lines.push(intervalWeeks > 1
      ? `${slot.day_of_week} ${durationLabel} (${roomLabel})${freqLabel}: £${(ratePence / 100).toFixed(2)} ÷ ${intervalWeeks} = £${(weeklyPence / 100).toFixed(2)}/week`
      : `${slot.day_of_week} ${durationLabel} (${roomLabel}): £${(weeklyPence / 100).toFixed(2)}/week`);
  }
  const monthlyPence = Math.round(weeklyTotalPence * WEEKS_PER_MONTH);
  return { lines, weeklyTotalPence, monthlyPence };
}

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
    const { notifyAdmins } = require('./notifyAdmins');
    await notifyAdmins(supabase, {
      relatedMemberId: member.id,
      subject: `Subscription setup failed — ${memberName}`,
      body: `Failed to set up ${memberName}'s monthly membership subscription after their Direct Debit went active (${result.error}). Their recurring slot fee won't be collected until this is fixed — use 'Create subscription now' in Manage Member, or check the GoCardless dashboard directly.`,
    });
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
