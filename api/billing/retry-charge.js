const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');

// POST /api/billing/retry-charge
// Admin-only. Re-attempts the GoCardless one-off charge for a booking that
// needed payment but never got successfully charged — a failed attempt, or
// one that was never tried because the member had no active mandate at the
// time. Charges the member's CURRENT mandate now (so this also covers "they
// didn't have Direct Debit set up when they booked, but they do now").
//
// Team review 19 Aug 2026: "there needs to be a force payment... manual
// force payment function... for people who owe us money". Distinct from
// mark-paid.js (which records a payment taken outside the system, e.g.
// cash/card in person) — this one actually attempts to collect via
// GoCardless.
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
    return res.status(403).json({ error: 'Only Staff & Admin can retry a charge' });
  }

  const { booking_id } = req.body || {};
  if (!booking_id) return res.status(400).json({ error: 'booking_id is required' });

  const { data: booking, error: bookingErr } = await supabase
    .from('bookings')
    .select('id, payment_status, amount_pence, member_id, room:rooms(name)')
    .eq('id', booking_id)
    .maybeSingle();
  if (bookingErr) return res.status(500).json({ error: bookingErr.message });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.payment_status === 'paid') return res.status(400).json({ error: 'This booking is already paid.' });
  if (booking.payment_status === 'pending_manual' || booking.amount_pence == null) {
    return res.status(400).json({ error: 'This booking has no confirmed price to charge — use "Mark as paid" once you\'ve agreed an amount, or update the room\'s pricing category first.' });
  }

  const { data: member, error: memberErr } = await supabase
    .from('members')
    .select('id, first_name, last_name, mandate_status, gocardless_mandate_id')
    .eq('id', booking.member_id)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member || member.mandate_status !== 'active' || !member.gocardless_mandate_id) {
    return res.status(400).json({ error: 'This member has no active Direct Debit mandate to charge — they\'ll need to set one up, or you can collect payment another way and use "Mark as paid".' });
  }

  try {
    const { getGoCardlessClient, createOneOffPayment } = require('../_lib/gocardless');
    const client = getGoCardlessClient();
    const payment = await createOneOffPayment(client, {
      mandateId: member.gocardless_mandate_id,
      amountPence: booking.amount_pence,
      description: `${booking.room ? booking.room.name : 'Room'} booking (retry)`,
      // Distinct idempotency key from the original attempt (which used the
      // booking id alone) so a genuine retry isn't deduped away as a
      // no-op — this is a deliberate second attempt, not an accidental
      // double-submit.
      idempotencyKey: `retry:${booking.id}:${Date.now()}`,
    });
    await supabase.from('bookings').update({ gocardless_payment_id: payment.id }).eq('id', booking.id);
    await logAudit({
      actorId: requester.id,
      actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim(),
      action: 'payment_retry_charge',
      entityType: 'booking',
      entityId: booking.id,
      details: { amount_pence: booking.amount_pence, member_id: member.id, gocardless_payment_id: payment.id },
    });
    return res.status(200).json({ ok: true, gocardless_payment_id: payment.id });
  } catch (e) {
    const detail = (e.errors && e.errors.length) ? e.errors.map(x => [x.field, x.message || x.reason].filter(Boolean).join(': ')).join('; ') : e.message;
    return res.status(502).json({ error: `GoCardless charge failed: ${detail}` });
  }
};
