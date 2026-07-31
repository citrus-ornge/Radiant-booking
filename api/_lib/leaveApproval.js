const { sendLeaveUpdate, sendLeaveDecision } = require('./email');
const { createCalendarEvent, deleteCalendarEvent } = require('./google');

const TEAM_CALENDAR_EMAIL = 'support@radiantfr.com';

function addDays(dateISO, days) {
  const d = new Date(dateISO + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function syncOneCalendar(supabase, entry, account, eventIdField, staffDisplayName) {
  if (!account || !account.google_calendar_connected || !account.google_refresh_token) return;
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

function fmtRange(rows, dateField) {
  const dates = rows.map(r => new Date(r[dateField])).sort((a, b) => a - b);
  const fmt = d => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return rows.length === 1 ? fmt(dates[0]) : `${fmt(dates[0])} to ${fmt(dates[dates.length - 1])} (${rows.length} day${rows.length > 1 ? 's' : ''})`;
}

async function approveLeaveBatch(supabase, token, approverId) {
  const { data: rows } = await supabase.from('leave_days').select('*').eq('approval_token', token);
  if (!rows || rows.length === 0) return { error: 'Leave request not found' };
  const pending = rows.filter(r => r.status === 'pending');
  if (pending.length === 0) return { error: `This request has already been ${rows[0].status}`, entries: rows };

  const { data: updated, error } = await supabase
    .from('leave_days')
    .update({ status: 'approved', approved_by: approverId || null, approved_at: new Date().toISOString() })
    .eq('approval_token', token)
    .eq('status', 'pending')
    .select();
  if (error) return { error: error.message };

  let member = null;
  if (updated[0].member_id) {
    const { data } = await supabase.from('members').select('email, first_name, last_name, google_calendar_connected, google_refresh_token').eq('id', updated[0].member_id).maybeSingle();
    member = data;
  }
  const { data: teamAccount } = await supabase.from('members').select('google_calendar_connected, google_refresh_token').eq('email', TEAM_CALENDAR_EMAIL).maybeSingle();
  for (const entry of updated) {
    if (member) await syncOneCalendar(supabase, entry, member, 'google_event_id', entry.staff_name);
    await syncOneCalendar(supabase, entry, teamAccount, 'team_google_event_id', entry.staff_name);
  }

  if (member) {
    try {
      await sendLeaveUpdate({ to: member.email, staffName: member.first_name || updated[0].staff_name, leaveDate: updated[0].leave_date, code: updated[0].code, removed: false, rangeText: fmtRange(updated, 'leave_date') });
    } catch (e) {}
  }

  return { entries: updated };
}

async function declineLeaveBatch(supabase, token, approverId, reason) {
  const { data: rows } = await supabase.from('leave_days').select('*').eq('approval_token', token);
  if (!rows || rows.length === 0) return { error: 'Leave request not found' };
  const pending = rows.filter(r => r.status === 'pending');
  if (pending.length === 0) return { error: `This request has already been ${rows[0].status}`, entries: rows };

  const { data: updated, error } = await supabase
    .from('leave_days')
    .update({ status: 'declined', approved_by: approverId || null, approved_at: new Date().toISOString(), decline_reason: reason || null })
    .eq('approval_token', token)
    .eq('status', 'pending')
    .select();
  if (error) return { error: error.message };

  if (updated[0].member_id) {
    const { data: member } = await supabase.from('members').select('email, first_name').eq('id', updated[0].member_id).maybeSingle();
    if (member) {
      try {
        await sendLeaveDecision({ to: member.email, staffName: member.first_name || updated[0].staff_name, leaveDate: updated[0].leave_date, code: updated[0].code, approved: false, reason, rangeText: fmtRange(updated, 'leave_date') });
      } catch (e) {}
    }
  }

  return { entries: updated };
}

module.exports = { approveLeaveBatch, declineLeaveBatch, fmtRange };
