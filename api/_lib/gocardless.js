const gocardless = require('gocardless-nodejs');
const { Environments } = require('gocardless-nodejs/constants');

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

module.exports = { getGoCardlessClient, PLAN_TIER_MONTHLY_PENCE };
