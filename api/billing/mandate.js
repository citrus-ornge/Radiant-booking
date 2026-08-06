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
      // We already have their name/email — skip re-asking for it in the flow.
      lock_customer_details: true,
    });

    await supabase
      .from('members')
      .update({ mandate_status: 'pending' })
      .eq('id', member.id);

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
    console.error('GoCardless mandate setup failed:', e.message);
    return res.status(502).json({ error: 'Could not start Direct Debit setup. Please try again or contact Staff & Admin.' });
  }
};
