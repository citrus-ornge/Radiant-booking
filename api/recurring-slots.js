const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');

// GET /api/recurring-slots?member_id=X  — list a member's recurring slots
// POST /api/recurring-slots { member_id, day_of_week, time_start, time_end, room_id }  — admin only, add a slot
// DELETE /api/recurring-slots?id=X  — admin only, remove a slot
//
// A Core/Resident member can have more than one recurring slot per week
// (e.g. a full day Monday plus a half day Friday) — this replaces the old
// single reserved_day_of_week/time_start/time_end/room_id columns on
// members, which could only ever represent one.
module.exports = async (req, res) => {
  const supabase = getSupabase();

  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }
  const isAdmin = requester.user_type === 'administrator';

  if (req.method === 'GET') {
    const memberId = req.query.member_id;
    if (!memberId) return res.status(400).json({ error: 'member_id is required' });
    if (memberId !== requester.id && !isAdmin) {
      return res.status(403).json({ error: 'You can only view your own recurring slots' });
    }
    const { data, error } = await supabase
      .from('member_recurring_slots')
      .select('id, day_of_week, time_start, time_end, room_id, room:rooms(id, name)')
      .eq('member_id', memberId)
      .order('day_of_week');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ slots: data });
  }

  if (req.method === 'POST') {
    if (!isAdmin) return res.status(403).json({ error: 'Only Staff & Admin can set recurring slots' });
    const { member_id, day_of_week, time_start, time_end, room_id } = req.body || {};
    if (!member_id || !day_of_week || !time_start || !time_end) {
      return res.status(400).json({ error: 'member_id, day_of_week, time_start and time_end are required' });
    }
    // Rosie, 23 Aug: "residents and core can only have full or half days".
    // The client UI now computes time_end from a Half/Full day duration
    // rather than a free-form end-time picker (a real 6-hour block slipped
    // through before that), but this endpoint had nothing stopping a
    // direct API call from setting any arbitrary duration regardless —
    // checked here too rather than trusting the client alone.
    const [startH, startM] = time_start.split(':').map(Number);
    const [endH, endM] = time_end.split(':').map(Number);
    const durationHours = (endH * 60 + endM - (startH * 60 + startM)) / 60;
    if (![4, 8].includes(durationHours)) {
      return res.status(400).json({ error: 'Core and Resident recurring slots must be exactly a half day (4hrs) or full day (8hrs)' });
    }
    const { data: target, error: targetErr } = await supabase.from('members').select('id, first_name, last_name, plan_tier').eq('id', member_id).maybeSingle();
    if (targetErr) return res.status(500).json({ error: targetErr.message });
    if (!target) return res.status(404).json({ error: 'Member not found' });

    const { data: slot, error } = await supabase
      .from('member_recurring_slots')
      .insert({ member_id, day_of_week, time_start, time_end, room_id: room_id || null })
      .select('id, day_of_week, time_start, time_end, room_id, room:rooms(id, name)')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    await logAudit({
      actorId: requester.id,
      actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
      action: 'recurring_slot.added',
      entityType: 'member',
      entityId: member_id,
      details: { day_of_week, time_start, time_end, room_id, target_name: `${target.first_name || ''} ${target.last_name || ''}`.trim() },
    });

    return res.status(200).json({ slot });
  }

  if (req.method === 'DELETE') {
    if (!isAdmin) return res.status(403).json({ error: 'Only Staff & Admin can remove recurring slots' });
    const slotId = req.query.id;
    if (!slotId) return res.status(400).json({ error: 'id is required' });

    const { data: existing, error: findErr } = await supabase.from('member_recurring_slots').select('member_id, day_of_week').eq('id', slotId).maybeSingle();
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!existing) return res.status(404).json({ error: 'Slot not found' });

    const { error } = await supabase.from('member_recurring_slots').delete().eq('id', slotId);
    if (error) return res.status(500).json({ error: error.message });

    await logAudit({
      actorId: requester.id,
      actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
      action: 'recurring_slot.removed',
      entityType: 'member',
      entityId: existing.member_id,
      details: { day_of_week: existing.day_of_week },
    });

    return res.status(200).json({ deleted: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
