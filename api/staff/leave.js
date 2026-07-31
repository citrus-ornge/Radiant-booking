const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { sendLeaveUpdate } = require('../_lib/email');
const { createCalendarEvent, deleteCalendarEvent } = require('../_lib/google');

const TEAM_CALENDAR_EMAIL = 'support@radiantfr.com';

function addDays(dateISO, days) {
  const d = new Date(dateISO + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function syncOneCalendar(supabase, entry, account, removed, eventIdField, staffDisplayName) {
  if (!account || !account.google_calendar_connected || !account.google_refresh_token) return;
  if (removed) {
    if (entry[eventIdField]) {
      try { await deleteCalendarEvent({ refreshToken: account.google_refresh_token, eventId: entry[eventIdField] }); } catch (e) {}
    }
    return;
  }
  try {
    const codeLabel = { AL: 'Annual Leave', BH: 'Bank Holiday', SICK: 'Sick Leave', OTHER: 'Leave' }[entry.code] || entry.code;
    const summary = eventIdField === 'team_google_event_id' ? `Radiant — ${staffDisplayName} — ${codeLabel}` : `Radiant — ${codeLabel}`;
    const event = await createCalendarEvent({
      refreshToken: account.google_refresh_token, summary,
      description: 'Synced from the Radiant Booking leave calendar',
      allDay: true, startDate: entry.leave_date, endDate: addDays(entry.leave_date, 1),
    });
    if (event && event.id) await supabase.from('leave_days').update({ [eventIdField]: event.id }).eq('id', entry.id);
  } catch (e) {}
}

async function syncCalendarsForRow(supabase, entry, removed) {
  let member = null;
  if (entry.member_id) {
    const { data } = await supabase.from('members').select('email, first_name, last_name, google_calendar_connected, google_refresh_token').eq('id', entry.member_id).maybeSingle();
    member = data;
    if (member) await syncOneCalendar(supabase, entry, member, removed, 'google_event_id', entry.staff_name);
  }
  const { data: teamAccount } = await supabase.from('members').select('google_calendar_connected, google_refresh_token').eq('email', TEAM_CALENDAR_EMAIL).maybeSingle();
  await syncOneCalendar(supabase, entry, teamAccount, removed, 'team_google_event_id', entry.staff_name);
  return member;
}

async function notifyBulk(rows, removed, memberByEntry) {
  if (rows.length === 0) return;
  const first = rows[0];
  const member = memberByEntry.get(first.id);
  if (!member) return;
  const dates = rows.map(r => new Date(r.leave_date)).sort((a, b) => a - b);
  const fmt = d => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const rangeText = rows.length === 1 ? fmt(dates[0]) : `${fmt(dates[0])} to ${fmt(dates[dates.length - 1])} (${rows.length} day${rows.length > 1 ? 's' : ''})`;
  try {
    await sendLeaveUpdate({ to: member.email, staffName: member.first_name || first.staff_name, leaveDate: first.leave_date, code: first.code, removed, rangeText });
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
    return res.status(403).json({ error: 'Leave calendar access is limited to Staff & Admin' });
  }

  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('leave_days').select('*').order('leave_date', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ leave: data });
  }

  if (req.method === 'POST') {
    const { staff_name, member_id, leave_date, dates, code } = req.body || {};
    const dateList = Array.isArray(dates) && dates.length > 0 ? dates : (leave_date ? [leave_date] : []);
    if (!staff_name || dateList.length === 0 || !code) {
      return res.status(400).json({ error: 'staff_name, at least one date, and code are required' });
    }
    const rowsToInsert = dateList.map(d => ({ staff_name, member_id: member_id || null, leave_date: d, code }));
    const { data, error } = await supabase.from('leave_days').insert(rowsToInsert).select();
    if (error) return res.status(500).json({ error: error.message });

    const memberByEntry = new Map();
    for (const row of data) {
      try {
        const member = await syncCalendarsForRow(supabase, row, false);
        if (member) memberByEntry.set(row.id, member);
      } catch (e) {}
    }
    try { await notifyBulk(data, false, memberByEntry); } catch (e) {}

    return res.status(201).json({ leave: data });
  }

  if (req.method === 'DELETE') {
    const { id, ids } = req.body || {};
    const idList = Array.isArray(ids) && ids.length > 0 ? ids : (id ? [id] : []);
    if (idList.length === 0) return res.status(400).json({ error: 'id or ids is required' });

    const { data: existingRows } = await supabase.from('leave_days').select('*').in('id', idList);
    const { error } = await supabase.from('leave_days').delete().in('id', idList);
    if (error) return res.status(500).json({ error: error.message });

    if (existingRows && existingRows.length > 0) {
      const memberByEntry = new Map();
      for (const row of existingRows) {
        try {
          const member = await syncCalendarsForRow(supabase, row, true);
          if (member) memberByEntry.set(row.id, member);
        } catch (e) {}
      }
      try { await notifyBulk(existingRows, true, memberByEntry); } catch (e) {}
    }

    return res.status(200).json({ deleted: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
