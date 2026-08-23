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

    // Real gap found live (22 Aug): cancelling the subscription resource
    // stops FUTURE billing cycles, but GoCardless creates each cycle's
    // Payment as its own separate resource several days before the actual
    // charge_date — any payment already created for the upcoming cycle at
    // the moment you cancel is NOT touched by subscriptions.cancel() and
    // will still go out on schedule unless cancelled individually. Two
    // real £449 payments for real bank accounts sat right at that gap.
    // Only payments still in pending_customer_approval or
    // pending_submission can be cancelled via the API at all — once
    // GoCardless has actually submitted one to the bank, this can't stop
    // it and a refund would be the only remaining option.
    const { payments: linkedPayments } = await client.payments.list({ subscription: member.gocardless_subscription_id });
    const cancellablePayments = (linkedPayments || []).filter(p => ['pending_customer_approval', 'pending_submission'].includes(p.status));
    const paymentResults = [];
    for (const payment of cancellablePayments) {
      try {
        await client.payments.cancel(payment.id);
        paymentResults.push({ payment_id: payment.id, cancelled: true });
      } catch (e) {
        paymentResults.push({ payment_id: payment.id, cancelled: false, error: e.message });
      }
    }
    const uncancellable = (linkedPayments || []).filter(p => !['pending_customer_approval', 'pending_submission', 'cancelled'].includes(p.status));

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
      details: { subscription_id: member.gocardless_subscription_id, payments_cancelled: paymentResults, payments_not_cancellable: uncancellable.map(p => ({ id: p.id, status: p.status })) },
    });

    const warnings = [];
    if (paymentResults.some(p => !p.cancelled)) warnings.push('One or more linked payments failed to cancel — check the GoCardless dashboard directly.');
    if (uncancellable.length > 0) warnings.push(`${uncancellable.length} payment(s) already past the point where this can cancel them (e.g. already submitted to the bank) — a refund from the GoCardless dashboard is the only remaining option for those.`);

    // Real gap found the same night this endpoint was built: a warning
    // returned in the API response is only ever seen by whoever happened
    // to click the button, in that exact moment — anyone else on the team
    // has no way to know a payment needs manual attention in GoCardless.
    // notifyAdmins() (built for the same reason, same night) gives every
    // active admin both an in-app message and an email, not just this one
    // clicking admin a toast.
    if (warnings.length > 0) {
      const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;
      const { notifyAdmins } = require('../_lib/notifyAdmins');
      await notifyAdmins(supabase, {
        relatedMemberId: member.id,
        subject: `⚠ ${memberName}'s subscription cancellation needs manual follow-up`,
        body: `Cancelling ${memberName}'s (${member.email}) subscription didn't fully clean up in GoCardless: ${warnings.join(' ')} Check the GoCardless dashboard directly — some payments can only be stopped by a refund once they've been submitted to the bank.`,
      });
    }

    return res.status(200).json({
      ok: true,
      cancelled_subscription_id: member.gocardless_subscription_id,
      payments_cancelled: paymentResults.filter(p => p.cancelled).length,
      warnings,
    });
  } catch (e) {
    const detail = (e.errors && e.errors.length) ? e.errors.map(x => [x.field, x.message || x.reason].filter(Boolean).join(': ')).join('; ') : e.message;
    return res.status(502).json({ error: `GoCardless cancellation failed: ${detail}` });
  }
};
