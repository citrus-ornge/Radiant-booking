const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');

// POST /api/billing/sync-mandate { member_id }
//
// Admin-only, on-demand version of what the hourly cron
// (api/cron/sync-mandates.js) also does automatically — both call the same
// reconcileMemberMandate() in _lib/gocardless.js. Kept as a manual action
// too so an admin can force an immediate check (e.g. a member calls saying
// their bank just confirmed it) rather than waiting for the next cron run.
//
// Built after finding every mandate ever attempted across a month of
// testing sat stuck at pending_submission forever, gocardless_mandate_id
// never set — despite at least one confirmed case where the bank had
// genuinely notified the member their Direct Debit was set up. The mandate
// lifecycle webhook (api/webhooks/gocardless.js) has apparently never once
// been successfully processed in production. Neither this endpoint nor the
// cron fixes why — that needs GoCardless's own webhook delivery log,
// checked directly in their dashboard — but both mean nobody's stuck
// waiting on a webhook that, empirically, isn't working.
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
    return res.status(403).json({ error: 'Only Staff & Admin can sync a mandate' });
  }

  const { member_id } = req.body || {};
  if (!member_id) return res.status(400).json({ error: 'member_id is required' });

  const { data: member, error: memberErr } = await supabase
    .from('members')
    .select('id, first_name, last_name, email, plan_tier, mandate_status, gocardless_mandate_id, gocardless_billing_request_id, gocardless_subscription_id, custom_monthly_fee_pence')
    .eq('id', member_id)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: 'Member not found' });

  try {
    const { reconcileMemberMandate } = require('../_lib/gocardless');
    const result = await reconcileMemberMandate(supabase, member);
    if (!result.ok) return res.status(400).json({ error: result.error });

    if (result.changed) {
      await logAudit({
        actorId: requester.id, actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim(),
        action: 'billing.mandate_synced', entityType: 'member', entityId: member.id,
        details: { from: result.previous_status, to: result.new_status, mandate_id: result.mandate_id, trigger: 'manual' },
      });
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: `GoCardless sync failed: ${e.message}` });
  }
};
