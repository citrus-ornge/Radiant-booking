const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');

// POST /api/onboarding/room-terms { response: 'accept' | 'reject' }
// The step between documents and onboarding actually being done for
// Core/Resident practitioners: they've been offered a specific recurring
// slot (day/time/room) and must explicitly accept or reject it — signing
// the general membership documents doesn't imply agreeing to that specific
// slot. Accepting finishes onboarding (payment setup is prompted
// separately, on the resulting dashboard/profile — this endpoint doesn't
// trigger GoCardless itself). Rejecting notifies Staff & Admin and leaves
// onboarding at 'booking_pending' so a revised offer can go through the
// same flow again.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let member;
  try {
    const auth = await requireAuth(req);
    member = auth.member;
    if (!member) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  const { response } = req.body || {};
  if (!['accept', 'reject'].includes(response)) {
    return res.status(400).json({ error: "response must be 'accept' or 'reject'" });
  }

  const supabase = getSupabase();
  const { data: slots, error: slotsErr } = await supabase
    .from('member_recurring_slots')
    .select('day_of_week, time_start, time_end, room:rooms(name)')
    .eq('member_id', member.id)
    .order('day_of_week');
  if (slotsErr) return res.status(500).json({ error: slotsErr.message });
  if (!['core', 'resident'].includes(member.plan_tier) || !slots || slots.length === 0) {
    return res.status(400).json({ error: 'No room offer is awaiting your response.' });
  }

  const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;
  const slotDesc = slots.map(s => `${s.day_of_week} ${s.time_start}–${s.time_end}${s.room ? ` (${s.room.name})` : ''}`).join('; ');

  if (response === 'accept') {
    const { data: updated, error } = await supabase
      .from('members')
      .update({ room_terms_accepted_at: new Date().toISOString(), room_terms_rejected_at: null, onboarding_status: 'completed' })
      .eq('id', member.id)
      .select('*')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    await logAudit({
      actorId: member.id, actorName: memberName, action: 'onboarding.room_terms_accepted',
      entityType: 'member', entityId: member.id, details: { slots: slotDesc },
    });

    return res.status(200).json({ member: updated });
  }

  // Reject: notify every admin/owner so someone actually sees it (not just
  // one, in case they're unavailable), leave onboarding_status as
  // 'booking_pending' so accepting a revised offer later re-enters the same step.
  const { data: updated, error } = await supabase
    .from('members')
    .update({ room_terms_rejected_at: new Date().toISOString() })
    .eq('id', member.id)
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  const notifyBody = `${memberName} has declined their offered recurring slot(s) (${slotDesc}). Please review and offer a revised day/time/room.`;
  const { notifyAdmins } = require('../_lib/notifyAdmins');
  await notifyAdmins(supabase, {
    relatedMemberId: member.id,
    subject: `Room offer declined — ${memberName}`,
    body: notifyBody,
  });

  await logAudit({
    actorId: member.id, actorName: memberName, action: 'onboarding.room_terms_rejected',
    entityType: 'member', entityId: member.id, details: { slots: slotDesc },
  });

  return res.status(200).json({ member: updated });
};
