const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { authUser, member } = await requireAuth(req);
    if (!member) {
      return res.status(404).json({ error: 'No member record linked to this account yet', authEmail: authUser.email });
    }
    // Attach recurring slots directly so the frontend never has to make a
    // second call just to know a Core/Resident member's agreed day(s) —
    // they can have more than one (e.g. full day Monday + half day Friday).
    if (['core', 'resident'].includes(member.plan_tier)) {
      const supabase = getSupabase();
      const { data: slots } = await supabase
        .from('member_recurring_slots')
        .select('id, day_of_week, time_start, time_end, room_id, room:rooms(id, name)')
        .eq('member_id', member.id)
        .order('day_of_week');
      member.recurring_slots = slots || [];
    } else {
      member.recurring_slots = [];
    }
    res.status(200).json({ member });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
