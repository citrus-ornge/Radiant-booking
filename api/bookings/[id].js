const { getSupabase } = require('../_lib/supabase');
const { sendCancellationAlert } = require('../_lib/email');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  const { id } = req.query;
  const supabase = getSupabase();

  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  const { data: existing, error: existingErr } = await supabase.from('bookings').select('member_id').eq('id', id).single();
  if (existingErr) return res.status(404).json({ error: 'Booking not found' });
  if (requester.user_type !== 'administrator' && existing.member_id !== requester.id) {
    return res.status(403).json({ error: 'You can only manage your own bookings' });
  }

  if (req.method === 'PATCH') {
    const { status } = req.body || {};
    if (!['confirmed', 'pending', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'status must be confirmed, pending, or cancelled' });
    }
    const { data: booking, error } = await supabase
      .from('bookings')
      .update({ status })
      .eq('id', id)
      .select(`
        id, start_time, end_time, status,
        room:rooms ( name ),
        member:members ( email )
      `)
      .single();
    if (error) return res.status(500).json({ error: error.message });

    let email_sent = false;
    if (status === 'cancelled') {
      try {
        await sendCancellationAlert({
          to: booking.member.email,
          roomName: booking.room.name,
          start: booking.start_time,
        });
        email_sent = true;
      } catch (e) {
        // don't fail the request over email issues
      }
    }
    return res.status(200).json({ booking, email_sent });
  }

  if (req.method === 'DELETE') {
    const { error } = await supabase.from('bookings').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  res.status(405).json({ error: 'Method not allowed' });
};
