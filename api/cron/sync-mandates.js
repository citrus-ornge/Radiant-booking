const { getSupabase } = require('../_lib/supabase');
const { logAudit } = require('../_lib/audit');

// Vercel Cron calls this hourly (see vercel.json). Guarded by CRON_SECRET so
// it can't be triggered by randoms hitting the URL.
//
// Built 22 Aug 2026 after finding every Direct Debit mandate ever attempted
// sat stuck at pending_submission indefinitely — the mandate lifecycle
// webhook (api/webhooks/gocardless.js) has apparently never once been
// successfully processed in production, despite mandates genuinely
// completing on GoCardless's/the bank's side. This is a safety net, not a
// fix — the actual cause still needs someone checking GoCardless's webhook
// delivery log directly (Developers -> Webhook endpoints in their
// dashboard) to see whether deliveries are reaching the endpoint at all or
// failing once there.
//
// Runs hourly rather than daily deliberately: a daily cadence would mean
// anyone could sit "processing" for up to 24 hours even with this safety
// net in place, on top of whatever's actually broken with the webhook.
// Given this directly affects real money and trust, and the realistic
// volume of members with an unresolved mandate at any moment is small,
// hourly costs nothing meaningful against GoCardless's API and removes the
// "stuck for days" experience entirely even if the webhook stays broken.
//
// Second thing this guards against: polling forever doesn't help if a
// mandate is stuck because the MEMBER never finished bank authorisation,
// or gave wrong details — not something reconciling against GoCardless will
// ever resolve, since GoCardless's own answer is correctly "still pending."
// Anyone unresolved for longer than a safe margin past GoCardless's normal
// ~1 business day (3 days here) gets flagged to admin once, so a human
// follows up with that specific person instead of this running forever
// with nobody the wiser.
const STUCK_THRESHOLD_DAYS = 3;

module.exports = async (req, res) => {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const results = { checked: 0, updated: 0, unchanged: 0, failed: [], stuck_flagged: [] };

  let reconcileMemberMandate;
  try {
    ({ reconcileMemberMandate } = require('../_lib/gocardless'));
  } catch (e) {
    return res.status(503).json({ error: `Payments are not configured (${e.message}).` });
  }

  // Anyone whose mandate hasn't reached a settled state yet, and actually
  // has something to check against GoCardless (either id works —
  // reconcileMemberMandate handles which one to use).
  const SETTLED_STATUSES = ['active', 'cancelled', 'failed', 'expired', 'consumed', 'blocked', 'suspended_by_payer'];
  const { data: candidates, error } = await supabase
    .from('members')
    .select('id, first_name, last_name, email, plan_tier, mandate_status, gocardless_mandate_id, gocardless_billing_request_id, gocardless_subscription_id, custom_monthly_fee_pence, mandate_setup_started_at')
    .not('mandate_status', 'in', `(${SETTLED_STATUSES.join(',')})`)
    .not('mandate_status', 'is', null)
    .eq('status', 'active');
  if (error) return res.status(500).json({ error: error.message });

  for (const member of candidates || []) {
    results.checked++;
    try {
      const result = await reconcileMemberMandate(supabase, member);
      if (!result.ok) { results.failed.push({ member_id: member.id, error: result.error }); continue; }

      if (result.changed) {
        results.updated++;
        await logAudit({
          actorId: null, actorName: 'GoCardless sync cron', action: 'billing.mandate_synced',
          entityType: 'member', entityId: member.id,
          details: { from: result.previous_status, to: result.new_status, mandate_id: result.mandate_id, trigger: 'cron' },
        });
      } else {
        results.unchanged++;
      }

      // Still unresolved after reconciling — check if it's been long enough
      // to actually flag, and whether it already was.
      const stillUnsettled = !SETTLED_STATUSES.includes(result.new_status || member.mandate_status);
      if (stillUnsettled && member.mandate_setup_started_at) {
        const daysSinceStart = (Date.now() - new Date(member.mandate_setup_started_at).getTime()) / 86400000;
        if (daysSinceStart >= STUCK_THRESHOLD_DAYS) {
          const { data: alreadyAlerted } = await supabase
            .from('audit_log')
            .select('id')
            .eq('action', 'billing.mandate_stuck_alert')
            .eq('entity_id', member.id)
            .limit(1);
          if (!alreadyAlerted || alreadyAlerted.length === 0) {
            const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;
            const { notifyAdmins } = require('../_lib/notifyAdmins');
            await notifyAdmins(supabase, {
              relatedMemberId: member.id,
              subject: `Direct Debit setup stuck — ${memberName}`,
              body: `${memberName}'s Direct Debit setup has been stuck ("${member.mandate_status}") for ${Math.floor(daysSinceStart)} days — well past GoCardless's normal ~1 business day. Likely they never finished bank authorisation, or entered something wrong. Worth following up with them directly rather than waiting further.`,
            });
            await logAudit({
              actorId: null, actorName: 'GoCardless sync cron', action: 'billing.mandate_stuck_alert',
              entityType: 'member', entityId: member.id,
              details: { status: member.mandate_status, days_stuck: Math.floor(daysSinceStart) },
            });
            results.stuck_flagged.push(member.id);
          }
        }
      }
    } catch (e) {
      results.failed.push({ member_id: member.id, error: e.message });
    }
  }

  return res.status(200).json(results);
};
