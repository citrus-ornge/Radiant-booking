const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');

// POST /api/billing/cancel-subscription { member_id }
//
// Admin-only. Actually cancels the member's recurring monthly membership
// subscription at GoCardless — not just clearing our own record, which
// would do nothing to stop a real future charge from actually landing.
// Built 22 Aug 2026 to stop a genuine live subscription (Jason's own test
// account, £449/month, first charge due 27 Aug) that was only ever
// cancellable by going into GoCardless's dashboard directly — this gives
// Staff & Admin the same ability from inside the app.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();
  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }
  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Only Staff & Admin can cancel a subscription' });
  }

  const { member_id } = req.body || {};
  if (!member_id) return res.status(400).json({ error: 'member_id is required' });

  const { data: member, error: memberErr } = await supabase
    .from('members')
    .select('id, first_name, last_name, email, gocardless_subscription_id')
    .eq('id', member_id)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: 'Member not found' });
  if (!member.gocardless_subscription_id) {
    return res.status(400).json({ error: 'This member has no active subscription to cancel.' });
  }

  try {
    const { getGoCardlessClient } = require('../_lib/gocardless');
    const client = getGoCardlessClient();
    await client.subscriptions.cancel(member.gocardless_subscription_id);

    // Cleared, not just flagged — so a genuinely new subscription could be
    // set up again later without ensureMembershipSubscription's
    // already_has_subscription guard blocking it. The cancelled
    // subscription's id and the fact it happened live on in audit_log.
    const { error: updateErr } = await supabase
      .from('members')
      .update({ gocardless_subscription_id: null })
      .eq('id', member.id);
    if (updateErr) return res.status(500).json({ error: `Cancelled at GoCardless but failed to update locally: ${updateErr.message}` });

    await logAudit({
      actorId: requester.id, actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim(),
      action: 'billing.subscription_cancelled', entityType: 'member', entityId: member.id,
      details: { subscription_id: member.gocardless_subscription_id },
    });

    return res.status(200).json({ ok: true, cancelled_subscription_id: member.gocardless_subscription_id });
  } catch (e) {
    const detail = (e.errors && e.errors.length) ? e.errors.map(x => [x.field, x.message || x.reason].filter(Boolean).join(': ')).join('; ') : e.message;
    return res.status(502).json({ error: `GoCardless cancellation failed: ${detail}` });
  }
};
