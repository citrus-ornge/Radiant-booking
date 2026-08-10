const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');
// _lib/gocardless is required lazily inside the handler (not at module load
// time) — if there's ever a problem loading that library or its native
// gocardless-nodejs dependency, this returns a clean 503 instead of the
// whole function failing to load for every request, including ones that
// hit this file before even reaching the GoCardless-specific code.

// POST /api/billing/mandate
// Starts (or restarts) Direct Debit setup for the calling member: creates a
// GoCardless customer if they don't have one yet, opens a Billing Request for
// a mandate, wraps it in a Billing Request Flow, and returns the hosted
// authorisation_url for the browser to redirect the member to. GoCardless's
// hosted flow collects/confirms bank details and handles bank authorisation;
// completion is reported back to us asynchronously via the webhook in
// api/webhooks/gocardless.js, which flips members.mandate_status to 'active'
// once the mandate is usable — this endpoint only gets things started.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let member;
  try {
    const auth = await requireAuth(req);
    member = auth.member;
    if (!member) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  if (member.user_type !== 'practitioner') {
    return res.status(400).json({ error: 'Direct Debit setup is only applicable to practitioner memberships.' });
  }

  const supabase = getSupabase();
  let client, getOrCreateCustomer;
  try {
    const gc = require('../_lib/gocardless');
    getOrCreateCustomer = gc.getOrCreateCustomer;
    client = gc.getGoCardlessClient();
  } catch (e) {
    console.error('Failed to load/init GoCardless client:', e.message);
    return res.status(503).json({ error: 'Payments are not configured yet. Please contact Staff & Admin.' });
  }

  try {
    const customerId = await getOrCreateCustomer(supabase, client, member);

    const billingRequest = await client.billingRequests.create({
      mandate_request: { scheme: 'bacs' },
      links: { customer: customerId },
    });

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const billingRequestFlow = await client.billingRequestFlows.create({
      links: { billing_request: billingRequest.id },
      redirect_uri: `${origin}/#profile?billing=complete`,
      exit_uri: `${origin}/#profile?billing=cancelled`,
      // Prefill what we already have (name/email) rather than lock_customer_details:
      // locking assumes their FULL details (including a billing address, which we
      // don't collect anywhere in onboarding) are already complete enough to skip
      // that step entirely — GoCardless rejects the lock when they're not. Prefilling
      // still saves them re-typing their name/email without requiring that.
      prefilled_customer: {
        given_name: member.first_name || undefined,
        family_name: member.last_name || undefined,
        email: member.email || undefined,
      },
    });

    // 'pending_submission' matches GoCardless's own mandate.status vocabulary
    // (also what the members.mandate_status CHECK constraint actually allows —
    // a generic 'pending' was silently rejected by that constraint before,
    // and since this write's error was never checked, it failed with no
    // indication anywhere. Always check errors on writes that matter.)
    const { error: statusErr } = await supabase
      .from('members')
      .update({ mandate_status: 'pending_submission' })
      .eq('id', member.id);
    if (statusErr) console.error(`Failed to set mandate_status=pending_submission for member ${member.id}:`, statusErr.message);

    await logAudit({
      actorId: member.id,
      actorName: `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email,
      action: 'billing.mandate_setup_started',
      entityType: 'member',
      entityId: member.id,
      details: { billing_request_id: billingRequest.id },
    });

    return res.status(200).json({ authorisation_url: billingRequestFlow.authorisation_url });
  } catch (e) {
    // GoCardless SDK errors carry structured detail (e.errors is an array of
    // { message, reason, field }) that's far more useful than e.message
    // alone for server-side debugging — e.g. "scheme is not supported" vs a
    // generic failure. Logged, not shown to the member (see mandate.js commit
    // history for why this was briefly user-facing while chasing real bugs).
    const detail = (e.errors && e.errors.length)
      ? e.errors.map(x => [x.field, x.message || x.reason].filter(Boolean).join(': ')).join('; ')
      : e.message;
    console.error('GoCardless mandate setup failed:', detail, JSON.stringify(e.errors || null));
    return res.status(502).json({ error: 'Could not start Direct Debit setup. Please try again or contact Staff & Admin.' });
  }
};
