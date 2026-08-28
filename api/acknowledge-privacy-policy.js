const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');

// Deliberately a small, standalone endpoint rather than folded into the
// generic members PATCH or the existing onboarding document-signing flow
// (team review 26 Aug 2026: "building things inside probably is more
// complex and prone to affect other code" — correct instinct). Sets
// privacy_policy_acknowledged_at for the requester's own record only, and
// writes a clean, dedicated audit entry — never touches onboarding_status,
// mandate/DD gating, or any document-signature logic at all.
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

  const supabase = getSupabase();
  const now = new Date().toISOString();
  const { data: member, error } = await supabase
    .from('members')
    .update({ privacy_policy_acknowledged_at: now })
    .eq('id', requester.id)
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    actorId: requester.id,
    actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
    action: 'privacy_policy.acknowledged',
    entityType: 'member',
    entityId: requester.id,
    details: { acknowledged_at: now },
  });

  res.status(200).json({ member });
};
