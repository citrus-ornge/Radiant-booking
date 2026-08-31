const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { sendRotaUpdate } = require('../_lib/email');
const { createCalendarEvent, deleteCalendarEvent } = require('../_lib/google');

const TEAM_CALENDAR_EMAIL = 'support@radiantfr.com';
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function parseTimeRange(timeRange, shiftDateISO) {
  if (!timeRange) return null;
  const cleaned = timeRange.replace(/(\d{1,2})\.(\d{2})/g, '$1:$2');
  const matches = cleaned.match(/(\d{1,2}:\d{2})/g);
  if (!matches || matches.length < 2) return null;
  const [startTime, endTime] = matches;
  return { startISO: `${shiftDateISO}T${startTime}:00`, endISO: `${shiftDateISO}T${endTime}:00` };
}

async function syncOneCalendar(supabase, shift, account, removed, eventIdField, staffDisplayName) {
  if (!account || !account.google_calendar_connected || !account.google_refresh_token) return;
  if (removed) {
    if (shift[eventIdField]) {
      try { await deleteCalendarEvent({ refreshToken: account.google_refresh_token, eventId: shift[eventIdField] }); } catch (e) {}
    }
    return;
  }
  try {
    const statusLabel = { scheduled: 'Working', closed: 'Closed', annual_leave: 'Annual Leave', tbc: 'Shift TBC' }[shift.status] || shift.status;
    const summary = eventIdField === 'team_google_event_id' ? `Radiant Rota — ${staffDisplayName} — ${statusLabel}` : `Radiant Rota — ${statusLabel}`;
    const parsed = shift.status === 'scheduled' ? parseTimeRange(shift.time_range, shift.shift_date) : null;
    const event = parsed
      ? await createCalendarEvent({ refreshToken: account.google_refresh_token, summary, description: 'Synced from the Radiant Booking rota', startISO: parsed.startISO, endISO: parsed.endISO })
      : await createCalendarEvent({ refreshToken: account.google_refresh_token, summary, description: 'Synced from the Radiant Booking rota', allDay: true, startDate: shift.shift_date, endDate: shift.shift_date });
    if (event && event.id) await supabase.from('rota_shifts').update({ [eventIdField]: event.id }).eq('id', shift.id);
  } catch (e) {}
}

async function syncCalendarsForRow(supabase, shift, removed) {
  let member = null;
  if (shift.member_id) {
    const { data } = await supabase.from('members').select('email, first_name, last_name, google_calendar_connected, google_refresh_token').eq('id', shift.member_id).maybeSingle();
    member = data;
    if (member) await syncOneCalendar(supabase, shift, member, removed, 'google_event_id', shift.staff_name);
  }
  const { data: teamAccount } = await supabase.from('members').select('google_calendar_connected, google_refresh_token').eq('email', TEAM_CALENDAR_EMAIL).maybeSingle();
  await syncOneCalendar(supabase, shift, teamAccount, removed, 'team_google_event_id', shift.staff_name);
  return member;
}

async function notifyBulk(rows, removed, memberByShift) {
  if (rows.length === 0) return;
  const first = rows[0];
  const member = memberByShift.get(first.id);
  if (!member) return;
  const dates = rows.map(r => new Date(r.shift_date));
  const sorted = [...dates].sort((a, b) => a - b);
  const fmt = d => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  const rangeText = rows.length === 1 ? fmt(sorted[0]) : `${fmt(sorted[0])} to ${fmt(sorted[sorted.length - 1])} (${rows.length} day${rows.length > 1 ? 's' : ''})`;
  const recipients = [...new Set([member.email, 'support@radiantfr.com', 'karen@radiantfr.com'])];
  try {
    await sendRotaUpdate({
      to: recipients,
      staffName: member.first_name || first.staff_name,
      shiftDate: first.shift_date,
      dayOfWeek: first.day_of_week,
      timeRange: rows.length === 1 ? first.time_range : null,
      status: first.status,
      removed,
      rangeText,
    });
  } catch (e) {}
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

  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Staff Area is limited to Staff & Admin' });
  }

  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('rota_shifts').select('*').order('shift_date', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ shifts: data });
  }

  if (req.method === 'POST') {
    const { staff_name, member_id, shift_date, dates, time_range, status } = req.body || {};
    const dateList = Array.isArray(dates) && dates.length > 0 ? dates : (shift_date ? [shift_date] : []);
    if (!staff_name || dateList.length === 0) {
      return res.status(400).json({ error: 'staff_name and at least one date are required' });
    }
    const rowsToInsert = dateList.map(d => ({
      staff_name, member_id: member_id || null, shift_date: d,
      day_of_week: DAY_NAMES[new Date(d + 'T00:00:00').getDay()],
      time_range, status: status || 'scheduled',
    }));
    const { data, error } = await supabase.from('rota_shifts').insert(rowsToInsert).select();
    if (error) return res.status(500).json({ error: error.message });

    const memberByShift = new Map();
    for (const row of data) {
      try {
        const member = await syncCalendarsForRow(supabase, row, false);
        if (member) memberByShift.set(row.id, member);
      } catch (e) {}
    }
    try { await notifyBulk(data, false, memberByShift); } catch (e) {}

    return res.status(201).json({ shifts: data });
  }

  if (req.method === 'DELETE') {
    const { id, ids } = req.body || {};
    const idList = Array.isArray(ids) && ids.length > 0 ? ids : (id ? [id] : []);
    if (idList.length === 0) return res.status(400).json({ error: 'id or ids is required' });

    const { data: existingRows } = await supabase.from('rota_shifts').select('*').in('id', idList);
    const { error } = await supabase.from('rota_shifts').delete().in('id', idList);
    if (error) return res.status(500).json({ error: error.message });

    if (existingRows && existingRows.length > 0) {
      const memberByShift = new Map();
      for (const row of existingRows) {
        try {
          const member = await syncCalendarsForRow(supabase, row, true);
          if (member) memberByShift.set(row.id, member);
        } catch (e) {}
      }
      try { await notifyBulk(existingRows, true, memberByShift); } catch (e) {}
    }

    return res.status(200).json({ deleted: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
