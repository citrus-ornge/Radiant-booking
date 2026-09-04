const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { syncUpcomingSlotBookings } = require('./_lib/recurringBookingSync');

// POST /api/sync-recurring-bookings { member_id }
// Admin-only manual trigger for one member — same underlying function the
// daily cron (api/cron/sync-recurring-bookings.js) runs for everyone.
// Exists so this can be reviewed on a single person first, rather than
// only ever running in bulk, unattended, overnight.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }
  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Only Staff & Admin can do this' });
  }

  const { member_id } = req.body || {};
  if (!member_id) return res.status(400).json({ error: 'member_id is required' });

  const supabase = getSupabase();
  const { data: member, error: memberErr } = await supabase.from('members').select('id, plan_tier').eq('id', member_id).maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: 'Member not found' });

  const result = await syncUpcomingSlotBookings(supabase, member);
  return res.status(200).json(result);
};
