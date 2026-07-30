const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { sendRotaUpdate } = require('../_lib/email');
const { createCalendarEvent, deleteCalendarEvent } = require('../_lib/google');

// Best-effort parser for the messy real-world time formats seen in the rota
// (e.g. "9:30 - 16:00", "10:00 -16:00", "07:45 - 14.15"). Returns null if it
// can't confidently parse two times, in which case calendar sync is skipped
// but everything else (DB row, email) still succeeds.
function parseTimeRange(timeRange, shiftDateISO) {
  if (!timeRange) return null;
  const cleaned = timeRange.replace(/(\d{1,2})\.(\d{2})/g, '$1:$2'); // "14.15" -> "14:15"
  const matches = cleaned.match(/(\d{1,2}:\d{2})/g);
  if (!matches || matches.length < 2) return null;
  const [startTime, endTime] = matches;
  const startISO = `${shiftDateISO}T${startTime}:00`;
  const endISO = `${shiftDateISO}T${endTime}:00`;
  return { startISO, endISO };
}

async function notifyAndSync(supabase, shift, removed) {
  if (!shift.member_id) return;
  const { data: member } = await supabase
    .from('members')
    .select('email, first_name, last_name, google_calendar_connected, google_refresh_token')
    .eq('id', shift.member_id)
    .maybeSingle();
  if (!member) return;

  try {
    await sendRotaUpdate({
      to: member.email,
      staffName: member.first_name || shift.staff_name,
      shiftDate: shift.shift_date,
      dayOfWeek: shift.day_of_week,
      timeRange: shift.time_range,
      status: shift.status,
      removed,
    });
  } catch (e) { /* non-critical */ }

  if (!member.google_calendar_connected || !member.google_refresh_token) return;

  if (removed) {
    if (shift.google_event_id) {
      try { await deleteCalendarEvent({ refreshToken: member.google_refresh_token, eventId: shift.google_event_id }); } catch (e) {}
    }
    return;
  }

  try {
    const statusLabel = { scheduled: 'Working', closed: 'Closed', annual_leave: 'Annual Leave', tbc: 'Shift TBC' }[shift.status] || shift.status;
    const parsed = shift.status === 'scheduled' ? parseTimeRange(shift.time_range, shift.shift_date) : null;
    let event;
    if (parsed) {
      event = await createCalendarEvent({
        refreshToken: member.google_refresh_token,
        summary: `Radiant Rota — ${statusLabel}`,
        description: 'Synced from the Radiant Booking rota',
        startISO: parsed.startISO,
        endISO: parsed.endISO,
      });
    } else {
      event = await createCalendarEvent({
        refreshToken: member.google_refresh_token,
        summary: `Radiant Rota — ${statusLabel}`,
        description: 'Synced from the Radiant Booking rota',
        allDay: true,
        startDate: shift.shift_date,
        endDate: shift.shift_date,
      });
    }
    if (event && event.id) {
      await supabase.from('rota_shifts').update({ google_event_id: event.id }).eq('id', shift.id);
    }
  } catch (e) { /* non-critical */ }
}

module.exports = async (req, res) => {
  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  // Staff Area is Staff & Admin only
  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Staff Area is limited to Staff & Admin' });
  }

  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('rota_shifts')
      .select('*')
      .order('shift_date', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ shifts: data });
  }

  if (req.method === 'POST') {
    const { staff_name, member_id, shift_date, day_of_week, time_range, status } = req.body || {};
    if (!staff_name || !shift_date || !day_of_week) {
      return res.status(400).json({ error: 'staff_name, shift_date and day_of_week are required' });
    }
    const { data, error } = await supabase
      .from('rota_shifts')
      .insert({ staff_name, member_id: member_id || null, shift_date, day_of_week, time_range, status: status || 'scheduled' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    let notified = false;
    try { await notifyAndSync(supabase, data, false); notified = true; } catch (e) {}

    return res.status(201).json({ shift: data, notified });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const { data: existing } = await supabase.from('rota_shifts').select('*').eq('id', id).maybeSingle();
    const { error } = await supabase.from('rota_shifts').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    if (existing) { try { await notifyAndSync(supabase, existing, true); } catch (e) {} }

    return res.status(200).json({ deleted: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
