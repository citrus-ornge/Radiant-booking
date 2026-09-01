const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { attachComputedMemberFields } = require('./me');
const { logAudit } = require('./_lib/audit');

// GET /api/view-as?member_id=X — admin-only. Team review 26 Aug 2026:
// "enable us to see what the user can see" — returns a target member in
// the exact same shape /api/me does (reusing the same computed-fields
// logic), so the client can render its normal client-side views using
// this data with no special-casing. Read-only by design: this endpoint
// only ever fetches, never mutates, and the client enforces its own
// blanket read-only rule while "viewing as" (see startViewAs/api() in
// index.html) — this endpoint returning data isn't itself the safety
// boundary, the client-side write-blocking is.
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
  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Only Staff & Admin can use View As' });
  }

  const memberId = req.query.member_id;
  if (!memberId) return res.status(400).json({ error: 'member_id is required' });

  const supabase = getSupabase();
  const { data: member, error } = await supabase.from('members').select('*').eq('id', memberId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!member) return res.status(404).json({ error: 'Member not found' });

  await attachComputedMemberFields(member);

  // Logged so there's a real record of who looked at whose account and
  // when — the same instinct as every other audit entry in this app.
  await logAudit({
    actorId: requester.id,
    actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
    action: 'admin.viewed_as_member',
    entityType: 'member',
    entityId: member.id,
    details: { viewed_name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email },
  });

  res.status(200).json({ member });
};
