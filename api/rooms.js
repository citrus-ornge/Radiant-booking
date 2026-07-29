const { getSupabase } = require('./_lib/supabase');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  const { data, error } = await supabase.from('rooms').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json({ rooms: data });
};
