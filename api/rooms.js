const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('rooms').select('*').order('name');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ rooms: data });
  }

  if (req.method === 'POST') {
    try {
      const { member } = await requireAuth(req);
      if (!member || member.user_type !== 'administrator') {
        return res.status(403).json({ error: 'Only administrators can add rooms' });
      }
    } catch (e) {
      return res.status(e.status || 401).json({ error: e.message });
    }

    const { name, capacity, floor, accessible_to, notes } = req.body || {};
    if (!name || !capacity) return res.status(400).json({ error: 'name and capacity are required' });

    const { data, error } = await supabase
      .from('rooms')
      .insert({ name, capacity, floor, accessible_to: accessible_to || 'all', notes })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ room: data });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
