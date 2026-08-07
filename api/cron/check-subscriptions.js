const { getSupabase } = require('../_lib/supabase');
const { logAudit } = require('../_lib/audit');

// Vercel Cron calls this daily. Guarded by CRON_SECRET so it can't be
// triggered by randoms hitting the URL.
//
// Safety net for the "ensure we're actually paid" requirement: the
// subscription that collects a Core/Resident member's flat monthly fee is
// normally created automatically the moment their Direct Debit mandate goes
// active (via the webhook). This catches anyone who slipped through that —
// a missed webhook delivery, a transient GoCardless error, anything — by
// finding every member with an active mandate and no subscription, and
// retrying via the same ensureMembershipSubscription logic. Runs daily
// rather than relying on a single moment-in-time trigger to be the only
// chance this ever gets set up correctly.
module.exports = async (req, res) => {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const results = { checked: 0, created: 0, already_ok: 0, failed: [] };

  let ensureMembershipSubscription;
  try {
    ({ ensureMembershipSubscription } = require('../_lib/gocardless'));
  } catch (e) {
    return res.status(503).json({ error: `Payments are not configured (${e.message}).` });
  }

  const { data: candidates, error } = await supabase
    .from('members')
    .select('*')
    .in('plan_tier', ['core', 'resident'])
    .eq('mandate_status', 'active')
    .is('gocardless_subscription_id', null)
    .eq('status', 'active');
  if (error) return res.status(500).json({ error: error.message });

  for (const member of candidates || []) {
    results.checked++;
    const result = await ensureMembershipSubscription(supabase, member);
    if (result.created) {
      results.created++;
      await logAudit({
        actorId: null, actorName: 'Subscription safety-net cron', action: 'billing.subscription_created',
        entityType: 'member', entityId: member.id, details: { subscription_id: result.subscriptionId },
      });
    } else if (result.failed) {
      results.failed.push({ member_id: member.id, error: result.error });
      const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.id;
      const { data: admins } = await supabase.from('members').select('id').eq('user_type', 'administrator').eq('status', 'active');
      for (const admin of admins || []) {
        await supabase.from('messages').insert({
          sender_id: member.id, recipient_id: admin.id,
          body: `⚠ Still couldn't set up ${memberName}'s monthly membership subscription (${result.error}). Their recurring slot fee isn't being collected — please check the GoCardless dashboard or use 'Create subscription now' in Manage Member.`,
        });
      }
    } else {
      results.already_ok++;
    }
  }

  return res.status(200).json(results);
};
