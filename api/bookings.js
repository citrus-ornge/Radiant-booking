const { getSupabase } = require('./_lib/supabase');
const { sendBookingConfirmation, sendTeamBookingNotice } = require('./_lib/email');
const { createCalendarEvent } = require('./_lib/google');
const { requireAuth } = require('./_lib/auth');
const { checkRateLimit } = require('./_lib/rateLimit');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('bookings')
      .select(`
        id, start_time, end_time, status, notes, created_at,
        room:rooms ( id, name, emoji, floor ),
        member:members ( id, first_name, last_name, email, user_type, is_owner )
      `)
      .order('start_time', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ bookings: data });
  }

  if (req.method === 'POST') {
    const allowed = await checkRateLimit(`booking_create:${requester.id}`, 30, 3600);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many bookings created recently. Please wait a while before booking more.' });
    }

    const { room_id, member_id, start_time, end_time, notes } = req.body || {};
    if (!room_id || !member_id || !start_time || !end_time) {
      return res.status(400).json({ error: 'room_id, member_id, start_time, end_time are required' });
    }
    if (requester.user_type !== 'administrator' && member_id !== requester.id) {
      return res.status(403).json({ error: 'You can only create bookings for yourself' });
    }

    // Room booking rules: min/max duration and blackout dates
    const { data: roomRules, error: roomErr } = await supabase
      .from('rooms')
      .select('name, min_duration_minutes, max_duration_minutes, blackout_dates')
      .eq('id', room_id)
      .maybeSingle();
    if (roomErr) return res.status(500).json({ error: roomErr.message });
    if (roomRules) {
      const durationMinutes = (new Date(end_time) - new Date(start_time)) / 60000;
      if (roomRules.min_duration_minutes && durationMinutes < roomRules.min_duration_minutes) {
        return res.status(400).json({ error: `${roomRules.name} requires a minimum booking of ${roomRules.min_duration_minutes} minutes` });
      }
      if (roomRules.max_duration_minutes && durationMinutes > roomRules.max_duration_minutes) {
        return res.status(400).json({ error: `${roomRules.name} allows a maximum booking of ${roomRules.max_duration_minutes} minutes` });
      }
      const bookingDateStr = new Date(start_time).toISOString().slice(0, 10);
      if (roomRules.blackout_dates && roomRules.blackout_dates.includes(bookingDateStr)) {
        return res.status(400).json({ error: `${roomRules.name} is unavailable on ${bookingDateStr}` });
      }
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

    try {
      await sendTeamBookingNotice({
        memberName: `${member.first_name} ${member.last_name}`,
        roomName: room.name,
        start: booking.start_time,
        end: booking.end_time,
      });
    } catch (e) {
      // non-critical - the practitioner's own confirmation already succeeded
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
