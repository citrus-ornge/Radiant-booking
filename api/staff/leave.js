const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { sendLeaveUpdate } = require('../_lib/email');
const { createCalendarEvent, deleteCalendarEvent } = require('../_lib/google');

function addDays(dateISO, days) {
  const d = new Date(dateISO + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function notifyAndSync(supabase, entry, removed) {
  if (!entry.member_id) return;
  const { data: member } = await supabase
    .from('members')
    .select('email, first_name, last_name, google_calendar_connected, google_refresh_token')
    .eq('id', entry.member_id)
    .maybeSingle();
  if (!member) return;

  try {
    await sendLeaveUpdate({
      to: member.email,
      staffName: member.first_name || entry.staff_name,
      leaveDate: entry.leave_date,
      code: entry.code,
      removed,
    });
  } catch (e) { /* non-critical */ }

  if (!member.google_calendar_connected || !member.google_refresh_token) return;

  if (removed) {
    if (entry.google_event_id) {
      try { await deleteCalendarEvent({ refreshToken: member.google_refresh_token, eventId: entry.google_event_id }); } catch (e) {}
    }
    return;
  }

  try {
    const codeLabel = { AL: 'Annual Leave', BH: 'Bank Holiday', SICK: 'Sick Leave', OTHER: 'Leave' }[entry.code] || entry.code;
    const event = await createCalendarEvent({
      refreshToken: member.google_refresh_token,
      summary: `Radiant — ${codeLabel}`,
      description: 'Synced from the Radiant Booking leave calendar',
      allDay: true,
      startDate: entry.leave_date,
      endDate: addDays(entry.leave_date, 1), // Google all-day events use an exclusive end date
    });
    if (event && event.id) {
      await supabase.from('leave_days').update({ google_event_id: event.id }).eq('id', entry.id);
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

  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Leave calendar access is limited to Staff & Admin' });
  }

  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('leave_days')
      .select('*')
      .order('leave_date', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ leave: data });
  }

  if (req.method === 'POST') {
    const { staff_name, member_id, leave_date, code } = req.body || {};
    if (!staff_name || !leave_date || !code) {
      return res.status(400).json({ error: 'staff_name, leave_date and code are required' });
    }
    const { data, error } = await supabase
      .from('leave_days')
      .insert({ staff_name, member_id: member_id || null, leave_date, code })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    try { await notifyAndSync(supabase, data, false); } catch (e) {}

    return res.status(201).json({ leave: data });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const { data: existing } = await supabase.from('leave_days').select('*').eq('id', id).maybeSingle();
    const { error } = await supabase.from('leave_days').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    if (existing) { try { await notifyAndSync(supabase, existing, true); } catch (e) {} }

    return res.status(200).json({ deleted: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
