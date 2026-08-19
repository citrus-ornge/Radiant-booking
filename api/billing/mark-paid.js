const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');

// POST /api/billing/mark-paid
// Admin-only. Records a booking as paid WITHOUT going through GoCardless —
// for cash or card taken in person, or any payment collected outside the
// app. Distinct from retry-charge.js, which actually attempts to collect
// via the member's Direct Debit mandate.
//
// Also the only way to close out a 'pending_manual' booking (no rate-table
// price at all — see pricing.js's documented gap for 3hr/full-day sessions,
// or a room missing its pricing_category) since there's no amount to
// automatically charge for those; the admin supplies what was actually
// agreed and collected.
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
    return res.status(403).json({ error: 'Only Staff & Admin can mark a booking as paid' });
  }

  const { booking_id, amount_pence } = req.body || {};
  if (!booking_id) return res.status(400).json({ error: 'booking_id is required' });

  const { data: booking, error: bookingErr } = await supabase
    .from('bookings')
    .select('id, payment_status, amount_pence')
    .eq('id', booking_id)
    .maybeSingle();
  if (bookingErr) return res.status(500).json({ error: bookingErr.message });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.payment_status === 'paid') return res.status(400).json({ error: 'This booking is already marked as paid.' });
  if (booking.payment_status === 'not_required') return res.status(400).json({ error: "This booking doesn't require payment." });

  // pending_manual has no amount_pence yet — the admin must supply what was
  // actually agreed/collected. For pending/failed bookings that already
  // have a confirmed price, an override isn't expected, but if one's sent
  // (e.g. a partial payment was actually taken) it's trusted — this is an
  // admin-only action already, not something a member can reach.
  const finalAmount = amount_pence != null ? Math.round(Number(amount_pence)) : booking.amount_pence;
  if (finalAmount == null || Number.isNaN(finalAmount) || finalAmount < 0) {
    return res.status(400).json({ error: 'This booking has no price on record — please provide amount_pence (the amount actually collected).' });
  }

  const { error: updateErr } = await supabase
    .from('bookings')
    .update({ payment_status: 'paid', amount_pence: finalAmount })
    .eq('id', booking.id);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await logAudit({
    actorId: requester.id,
    actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim(),
    action: 'payment_marked_paid',
    entityType: 'booking',
    entityId: booking.id,
    details: { amount_pence: finalAmount, previous_status: booking.payment_status },
  });

  return res.status(200).json({ ok: true });
};
