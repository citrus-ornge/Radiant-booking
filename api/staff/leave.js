const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');

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
    if (requester.user_type !== 'administrator') {
      return res.status(403).json({ error: 'Only Staff & Admin can edit the leave calendar' });
    }
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
    return res.status(201).json({ leave: data });
  }

  if (req.method === 'DELETE') {
    if (requester.user_type !== 'administrator') {
      return res.status(403).json({ error: 'Only Staff & Admin can edit the leave calendar' });
    }
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { error } = await supabase.from('leave_days').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ deleted: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
