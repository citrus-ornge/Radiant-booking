const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');

// POST /api/onboarding/reset { member_id, stage }
// Admin-only. Resets a member back to an earlier onboarding stage — mainly
// for testing the onboarding flow repeatedly without re-doing signup each
// time, but also useful for real cases (e.g. a member needs to re-sign an
// updated document, or their offered slot needs re-confirming).
//
// stage: 'not_started' | 'documents_pending' | 'booking_pending'
// - not_started: also deletes their document signatures, so the documents
//   step genuinely has to be redone.
// - documents_pending: same as not_started but skips straight past the
//   profile step (assumes profile is already filled in).
// - booking_pending: leaves documents alone, just re-opens the room-offer
//   acceptance step (clears room_terms_accepted_at/rejected_at).
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
  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Only Staff & Admin can reset onboarding' });
  }

  const { member_id, stage } = req.body || {};
  if (!member_id || !['not_started', 'documents_pending', 'booking_pending'].includes(stage)) {
    return res.status(400).json({ error: "member_id and a valid stage ('not_started' | 'documents_pending' | 'booking_pending') are required" });
  }

  const supabase = getSupabase();
  const { data: target, error: targetErr } = await supabase.from('members').select('id, first_name, last_name, email').eq('id', member_id).maybeSingle();
  if (targetErr) return res.status(500).json({ error: targetErr.message });
  if (!target) return res.status(404).json({ error: 'Member not found' });

  const updates = { onboarding_status: stage };
  if (stage !== 'booking_pending') {
    updates.room_terms_accepted_at = null;
    updates.room_terms_rejected_at = null;
  }
  if (stage === 'booking_pending') {
    updates.room_terms_accepted_at = null;
    updates.room_terms_rejected_at = null;
  }

  if (['not_started', 'documents_pending'].includes(stage)) {
    const { error: delErr } = await supabase.from('document_signatures').delete().eq('member_id', member_id);
    if (delErr) return res.status(500).json({ error: delErr.message });
  }

  const { data: updated, error } = await supabase.from('members').update(updates).eq('id', member_id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    actorId: requester.id,
    actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
    action: 'onboarding.reset_for_testing',
    entityType: 'member',
    entityId: member_id,
    details: { stage, target_name: `${target.first_name || ''} ${target.last_name || ''}`.trim() || target.email },
  });

  return res.status(200).json({ member: updated });
};
