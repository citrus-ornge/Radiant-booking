const gocardless = require('gocardless-nodejs');
const { Environments } = require('gocardless-nodejs/constants');
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
  return gocardless(token, env);
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

module.exports = { getGoCardlessClient, PLAN_TIER_MONTHLY_PENCE, readRawBody, createOneOffPayment, createMembershipSubscription };

// (e.g. for a chargeable extra session). idempotencyKey should be stable per
// logical charge (we use the booking id) so a retried request never double-charges.
async function createOneOffPayment(client, { mandateId, amountPence, description, idempotencyKey }) {
  return client.payments.create(
    { amount: amountPence, currency: 'GBP', links: { mandate: mandateId }, description },
    idempotencyKey || crypto.randomUUID(),
  );
}

// Creates the flat recurring monthly membership charge for Core/Resident
// tiers, against an active mandate. Call this once per member (guarded by
// checking members.gocardless_subscription_id first) — calling it twice
// would create two subscriptions and double-bill them.
async function createMembershipSubscription(client, { mandateId, amountPence, name, idempotencyKey }) {
  return client.subscriptions.create(
    { amount: amountPence, currency: 'GBP', name, interval_unit: 'monthly', links: { mandate: mandateId } },
    idempotencyKey || crypto.randomUUID(),
  );
}
