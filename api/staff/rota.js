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

  // Only staff-facing roles can see the rota
  if (!['administrator', 'practitioner'].includes(requester.user_type)) {
    return res.status(403).json({ error: 'Rota access is limited to staff and practitioners' });
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
    if (requester.user_type !== 'administrator') {
      return res.status(403).json({ error: 'Only Staff & Admin can edit the rota' });
    }
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
    return res.status(201).json({ shift: data });
  }

  if (req.method === 'DELETE') {
    if (requester.user_type !== 'administrator') {
      return res.status(403).json({ error: 'Only Staff & Admin can edit the rota' });
    }
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { error } = await supabase.from('rota_shifts').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ deleted: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
