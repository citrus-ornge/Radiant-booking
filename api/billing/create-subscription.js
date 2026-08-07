const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');

// POST /api/billing/create-subscription { member_id }
// Admin-only manual recovery path: if the automatic subscription creation
// (triggered by the webhook when a mandate goes active) ever failed or was
// missed, this lets staff retry it directly without needing to touch the
// GoCardless dashboard. Uses the same ensureMembershipSubscription logic as
// the webhook and the daily safety-net cron, so the eligibility rules and
// idempotency guard are identical everywhere this can be triggered from.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }
  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Only Staff & Admin can do this' });
  }

  const { member_id } = req.body || {};
  if (!member_id) return res.status(400).json({ error: 'member_id is required' });

  const supabase = getSupabase();
  const { data: member, error: memberErr } = await supabase.from('members').select('*').eq('id', member_id).maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: 'Member not found' });

  let ensureMembershipSubscription;
  try {
    ({ ensureMembershipSubscription } = require('../_lib/gocardless'));
  } catch (e) {
    return res.status(503).json({ error: `Payments are not configured (${e.message}).` });
  }

  const result = await ensureMembershipSubscription(supabase, member);

  if (result.created) {
    await logAudit({
      actorId: requester.id,
      actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
      action: 'billing.subscription_created_manually',
      entityType: 'member',
      entityId: member.id,
      details: { subscription_id: result.subscriptionId },
    });
    return res.status(200).json({ created: true, subscription_id: result.subscriptionId });
  }
  if (result.failed) {
    return res.status(502).json({ error: result.error });
  }
  // skipped — tell the admin exactly why, rather than a generic "nothing happened"
  const reasonLabels = {
    not_eligible_tier: 'This member\'s tier doesn\'t have a flat monthly fee (Community/Flex, or plan_tier not set).',
    no_active_mandate: 'This member doesn\'t have an active Direct Debit mandate yet.',
    already_has_subscription: 'This member already has a subscription set up.',
  };
  return res.status(400).json({ error: reasonLabels[result.reason] || `Not applicable: ${result.reason}` });
};
