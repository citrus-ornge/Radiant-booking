const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  const supabase = getSupabase();

  // Non-admins get their own recent activity only (team review 26 Aug
  // 2026: "seems odd for users to have activities on their accounts and
  // not show in notifications") — billing, document, and onboarding
  // events all use entity_type='member' with entity_id=that member's own
  // id, so this can't leak anyone else's activity. Bookings and invites
  // use their own entity types (booking/invite) and are already covered
  // separately by the existing booking/invite-based notifications, so
  // deliberately excluded here to avoid duplicating those.
  if (requester.user_type !== 'administrator') {
    const { data, error } = await supabase
      .from('audit_log')
      .select('*')
      .eq('entity_type', 'member')
      .eq('entity_id', requester.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ entries: data });
  }

  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ entries: data });
};
