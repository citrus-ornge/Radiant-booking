const { getSupabase } = require('./_lib/supabase');
const { sendBookingConfirmation } = require('./_lib/email');
const { createCalendarEvent } = require('./_lib/google');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('bookings')
      .select(`
        id, start_time, end_time, status, notes, created_at,
        room:rooms ( id, name, emoji, floor ),
        member:members ( id, first_name, last_name, email, user_type )
      `)
      .order('start_time', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ bookings: data });
  }

  if (req.method === 'POST') {
    const { room_id, member_id, start_time, end_time, notes } = req.body || {};
    if (!room_id || !member_id || !start_time || !end_time) {
      return res.status(400).json({ error: 'room_id, member_id, start_time, end_time are required' });
    }

    // Overlap check: reject if the room already has a confirmed/pending
    // booking that overlaps the requested window.
    const { data: clashes, error: clashErr } = await supabase
      .from('bookings')
      .select('id')
      .eq('room_id', room_id)
      .neq('status', 'cancelled')
      .lt('start_time', end_time)
      .gt('end_time', start_time);
    if (clashErr) return res.status(500).json({ error: clashErr.message });
    if (clashes && clashes.length > 0) {
      return res.status(409).json({ error: 'This room is already booked for part of that time window.' });
    }

    const { data: booking, error } = await supabase
      .from('bookings')
      .insert({ room_id, member_id, start_time, end_time, notes, status: 'confirmed' })
      .select(`
        id, start_time, end_time, status, notes,
        room:rooms ( id, name, emoji, floor ),
        member:members ( id, first_name, last_name, email, user_type, google_calendar_connected, google_refresh_token )
      `)
      .single();
    if (error) return res.status(500).json({ error: error.message });

    const member = booking.member;
    const room = booking.room;

    // Fire-and-forget side effects — don't fail the booking if these fail,
    // just report what happened.
    const sideEffects = { email_sent: false, calendar_synced: false, warnings: [] };

    try {
      await sendBookingConfirmation({
        to: member.email,
        memberName: `${member.first_name} ${member.last_name}`,
        roomName: room.name,
        start: booking.start_time,
        end: booking.end_time,
      });
      sideEffects.email_sent = true;
    } catch (e) {
      sideEffects.warnings.push(`Email not sent: ${e.message}`);
    }

    if (member.google_calendar_connected && member.google_refresh_token) {
      try {
        const event = await createCalendarEvent({
          refreshToken: member.google_refresh_token,
          summary: `${room.name} — Radiant Booking`,
          description: notes || '',
          startISO: booking.start_time,
          endISO: booking.end_time,
        });
        await supabase.from('bookings').update({ google_event_id: event.id }).eq('id', booking.id);
        sideEffects.calendar_synced = true;
      } catch (e) {
        sideEffects.warnings.push(`Calendar sync failed: ${e.message}`);
      }
    }

    return res.status(201).json({ booking, ...sideEffects });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
