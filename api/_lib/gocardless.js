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
// TODO: confirm these against the current brochure rate card before going live.
const PLAN_TIER_MONTHLY_PENCE = {
  community: null, // Community tier is pay-as-you-go, no recurring subscription
  flex: 9900,
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

// Returns the member's GoCardless customer id, creating one (and persisting
// it) if they don't have one yet. Shared by mandate setup and Instant Bank
// Pay, both of which need a customer to attach the billing request to.
async function getOrCreateCustomer(supabase, client, member) {
  if (member.gocardless_customer_id) return member.gocardless_customer_id;
  const customer = await client.customers.create({
    email: member.email,
    given_name: member.first_name || undefined,
    family_name: member.last_name || undefined,
    country_code: 'GB',
  });
  const { error } = await supabase.from('members').update({ gocardless_customer_id: customer.id }).eq('id', member.id);
  if (error) throw new Error(`Saved GoCardless customer but failed to store it: ${error.message}`);
  return customer.id;
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
  const monthlyPence = PLAN_TIER_MONTHLY_PENCE[member.plan_tier];
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
    return { created: true, subscriptionId: subscription.id };
  } catch (e) {
    const detail = (e.errors && e.errors.length) ? e.errors.map(x => [x.field, x.message || x.reason].filter(Boolean).join(': ')).join('; ') : e.message;
    return { failed: true, error: detail };
  }
}

module.exports = { getGoCardlessClient, PLAN_TIER_MONTHLY_PENCE, readRawBody, createOneOffPayment, createMembershipSubscription, getOrCreateCustomer, ensureMembershipSubscription };
