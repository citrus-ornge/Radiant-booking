const { getSupabase } = require('../../_lib/supabase');
const { requireAuth } = require('../../_lib/auth');

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

  const { member_id } = req.body || {};
  let targetId = requester.id;
  if (member_id && member_id !== requester.id) {
    if (requester.user_type !== 'administrator') {
      return res.status(403).json({ error: 'Only administrators can disconnect another member\'s calendar' });
    }
    targetId = member_id;
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from('members')
    .update({ google_calendar_connected: false, google_refresh_token: null })
    .eq('id', targetId);
  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ disconnected: true });
};
