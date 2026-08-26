const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');
const { getGoCardlessClient, createOneOffPayment, calculateOutstandingBalanceAtCancellation } = require('../_lib/gocardless');

// POST /api/billing/collect-final-balance { member_id }
//
// Admin-only. Team review 26 Aug 2026: "on practitioner cancellation we
// collect any underpayment... calculate it and show admin the amount,
// admin clicks to actually collect it" — this is that click. Recalculates
// the outstanding balance server-side rather than trusting any amount the
// client might send (the figure shown in Manage Member could be stale by
// the time this is clicked — a moment's real difference matters here,
// since this creates a genuine charge), and requires the member's Direct
// Debit mandate to still be active — cancelling a subscription doesn't
// touch the mandate itself, but if it's since expired/failed there's
// nothing left to charge against via the API, and that needs a different
// collection method entirely (cash, card in person, etc — same as any
// other manual payment).
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
    return res.status(403).json({ error: 'Only Staff & Admin can collect a final balance' });
  }

  const { member_id } = req.body || {};
  if (!member_id) return res.status(400).json({ error: 'member_id is required' });

  const { data: member, error: memberErr } = await supabase
    .from('members')
    .select('id, first_name, last_name, email, plan_tier, plan_tier_started_at, custom_monthly_fee_pence, gocardless_subscription_id, gocardless_mandate_id, mandate_status')
    .eq('id', member_id)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: 'Member not found' });

  if (member.mandate_status !== 'active' || !member.gocardless_mandate_id) {
    return res.status(400).json({ error: 'This member has no active Direct Debit mandate to collect against — this needs a manual payment method instead (cash, card in person, etc).' });
  }

  let breakdown;
  try {
    breakdown = await calculateOutstandingBalanceAtCancellation(supabase, member);
  } catch (e) {
    return res.status(500).json({ error: `Could not calculate the outstanding balance: ${e.message}` });
  }
  if (!breakdown || breakdown.total_pence <= 0) {
    return res.status(400).json({ error: 'Nothing outstanding to collect — the balance is £0 or less.' });
  }

  try {
    const client = getGoCardlessClient();
    const payment = await createOneOffPayment(client, {
      mandateId: member.gocardless_mandate_id,
      amountPence: breakdown.total_pence,
      description: 'Final balance — outstanding amount on account closure',
      idempotencyKey: `final-balance:${member.id}`,
    });

    await logAudit({
      actorId: requester.id, actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim(),
      action: 'billing.final_balance_collected', entityType: 'member', entityId: member.id,
      details: { amount_pence: breakdown.total_pence, breakdown, payment_id: payment.id },
    });

    return res.status(200).json({ ok: true, payment_id: payment.id, amount_pence: breakdown.total_pence, breakdown });
  } catch (e) {
    const detail = (e.errors && e.errors.length) ? e.errors.map(x => [x.field, x.message || x.reason].filter(Boolean).join(': ')).join('; ') : e.message;
    return res.status(502).json({ error: `GoCardless payment failed: ${detail}` });
  }
};
