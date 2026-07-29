const { getSupabase } = require('../_lib/supabase');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { token } = req.query;
  const supabase = getSupabase();

  const { data: invite, error } = await supabase
    .from('invites')
    .select('email, user_type, personal_note, status, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.status === 'accepted') return res.status(410).json({ error: 'This invite has already been used' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'This invite has expired' });

  res.status(200).json({ invite });
};
