const crypto = require('crypto');
const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { sendLeaveApprovalRequest } = require('../_lib/email');
const { deleteCalendarEvent } = require('../_lib/google');
const { approveLeaveBatch, declineLeaveBatch, fmtRange } = require('../_lib/leaveApproval');

const TEAM_CALENDAR_EMAIL = 'support@radiantfr.com';

async function notifyApproversForRequest(supabase, rows, requesterName) {
  // Owners get first priority; fall back to any Staff & Admin if no owner is set up yet
  let { data: approvers } = await supabase.from('members').select('id, email, first_name').eq('is_owner', true).eq('status', 'active');
  if (!approvers || approvers.length === 0) {
    const { data: admins } = await supabase.from('members').select('id, email, first_name').eq('user_type', 'administrator').eq('status', 'active');
    approvers = admins || [];
  }
  if (approvers.length === 0) return;

  const token = rows[0].approval_token;
  const baseUrl = process.env.PUBLIC_APP_URL || 'https://booking.radiantfr.com';
  const approveUrl = `${baseUrl}/api/staff/leave-respond?token=${token}&action=approve`;
  const declineUrl = `${baseUrl}/api/staff/leave-respond?token=${token}&action=decline`;
  const rangeText = fmtRange(rows, 'leave_date');

  for (const approver of approvers) {
    try {
      await sendLeaveApprovalRequest({
        to: approver.email, approverName: approver.first_name,
        staffName: rows[0].staff_name, rangeText, code: rows[0].code,
        approveUrl, declineUrl,
      });
    } catch (e) {}
  }
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

    // One shared token for the whole batch, so a single Approve/Decline
    // click on the whole date range instead of per-day links.
    const batchToken = crypto.randomBytes(24).toString('hex');
    const rowsToInsert = dateList.map(d => ({
      staff_name, member_id: member_id || null, leave_date: d, code,
      status: 'pending', approval_token: batchToken, requested_by: requester.id,
    }));
    const { data, error } = await supabase.from('leave_days').insert(rowsToInsert).select();
    if (error) return res.status(500).json({ error: error.message });

    try { await notifyApproversForRequest(supabase, data, `${requester.first_name} ${requester.last_name}`.trim()); } catch (e) {}

    return res.status(201).json({ leave: data, pending_approval: true });
  }

  if (req.method === 'PATCH') {
    // In-app approve/decline (equivalent of the email links, but authenticated)
    const { token, action, reason } = req.body || {};
    if (!token || !['approve', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'token and a valid action (approve/decline) are required' });
    }
    const result = action === 'approve'
      ? await approveLeaveBatch(supabase, token, requester.id)
      : await declineLeaveBatch(supabase, token, requester.id, reason);
    if (result.error) return res.status(400).json({ error: result.error });
    return res.status(200).json({ entries: result.entries });
  }

  if (req.method === 'DELETE') {
    const { id, ids } = req.body || {};
    const idList = Array.isArray(ids) && ids.length > 0 ? ids : (id ? [id] : []);
    if (idList.length === 0) return res.status(400).json({ error: 'id or ids is required' });

    const { data: existingRows } = await supabase.from('leave_days').select('*').in('id', idList);
    const { error } = await supabase.from('leave_days').delete().in('id', idList);
    if (error) return res.status(500).json({ error: error.message });

    // Clean up any calendar events for entries that were already approved and synced
    if (existingRows) {
      for (const row of existingRows) {
        if (row.status !== 'approved') continue;
        try {
          if (row.member_id && row.google_event_id) {
            const { data: member } = await supabase.from('members').select('google_refresh_token').eq('id', row.member_id).maybeSingle();
            if (member && member.google_refresh_token) await deleteCalendarEvent({ refreshToken: member.google_refresh_token, eventId: row.google_event_id });
          }
          if (row.team_google_event_id) {
            const { data: teamAccount } = await supabase.from('members').select('google_refresh_token').eq('email', TEAM_CALENDAR_EMAIL).maybeSingle();
            if (teamAccount && teamAccount.google_refresh_token) await deleteCalendarEvent({ refreshToken: teamAccount.google_refresh_token, eventId: row.team_google_event_id });
          }
        } catch (e) {}
      }
    }

    return res.status(200).json({ deleted: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
