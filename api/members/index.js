const { getSupabase } = require('../_lib/supabase');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('members')
      .select('id, first_name, last_name, email, phone, user_type, status, google_calendar_connected, created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ members: data });
  }

  if (req.method === 'POST') {
    const { first_name, last_name, email, phone, user_type } = req.body || {};
    if (!first_name || !last_name || !email || !user_type) {
      return res.status(400).json({ error: 'first_name, last_name, email, and user_type are required' });
    }
    const { data, error } = await supabase
      .from('members')
      .insert({ first_name, last_name, email, phone, user_type })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ member: data });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
