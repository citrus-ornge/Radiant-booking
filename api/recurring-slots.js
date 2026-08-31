const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');
const { validateSessionBlock } = require('./_lib/sessionBlocks');

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
      .select('id, day_of_week, time_start, time_end, room_id, interval_weeks, anchor_date, room:rooms(id, name)')
      .eq('member_id', memberId)
      .order('day_of_week');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ slots: data });
  }

  if (req.method === 'POST') {
    if (!isAdmin) return res.status(403).json({ error: 'Only Staff & Admin can set recurring slots' });
    const { member_id, day_of_week, time_start, time_end, room_id, interval_weeks, anchor_date } = req.body || {};
    if (!member_id || !day_of_week || !time_start || !time_end) {
      return res.status(400).json({ error: 'member_id, day_of_week, time_start and time_end are required' });
    }
    // Rosie confirmed directly: Half day is fixed at 8am-1pm or 1pm-6pm,
    // Full day is fixed at 8am-6pm — no other start times or lengths are
    // valid (this is standard timetable pricing, not a flexible-start
    // model). The client UI only offers these three exact blocks now, but
    // this endpoint had nothing stopping a direct API call bypassing that.
    const blockError = validateSessionBlock(time_start, time_end);
    if (blockError) {
      return res.status(400).json({ error: `Core and Resident recurring slots ${blockError}` });
    }

    // Team review 26 Aug 2026: slots can recur every N weeks (weekly=1,
    // fortnightly=2, every 3rd week=3, etc.), not just every single week.
    // Fixed sanity cap at 12 (matches the DB check constraint) — a real
    // number field beyond that stops being a realistic recurring
    // membership pattern and is almost certainly a data-entry mistake.
    const intervalWeeksNum = interval_weeks != null ? parseInt(interval_weeks, 10) : 1;
    if (!Number.isInteger(intervalWeeksNum) || intervalWeeksNum < 1 || intervalWeeksNum > 12) {
      return res.status(400).json({ error: 'interval_weeks must be a whole number between 1 and 12' });
    }
    let anchorDateValue = null;
    if (intervalWeeksNum > 1) {
      if (!anchor_date) {
        return res.status(400).json({ error: 'anchor_date (the first occurrence) is required for a slot that repeats every ' + intervalWeeksNum + ' weeks' });
      }
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const anchorDayName = dayNames[new Date(anchor_date + 'T00:00:00Z').getUTCDay()];
      if (anchorDayName !== day_of_week) {
        return res.status(400).json({ error: `anchor_date (${anchor_date}) falls on a ${anchorDayName}, not ${day_of_week} — pick the actual first ${day_of_week} this slot starts from` });
      }
      anchorDateValue = anchor_date;
    }

    const { data: target, error: targetErr } = await supabase.from('members').select('id, first_name, last_name, plan_tier').eq('id', member_id).maybeSingle();
    if (targetErr) return res.status(500).json({ error: targetErr.message });
    if (!target) return res.status(404).json({ error: 'Member not found' });

    const { data: slot, error } = await supabase
      .from('member_recurring_slots')
      .insert({ member_id, day_of_week, time_start, time_end, room_id: room_id || null, interval_weeks: intervalWeeksNum, anchor_date: anchorDateValue })
      .select('id, day_of_week, time_start, time_end, room_id, interval_weeks, anchor_date, room:rooms(id, name)')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    await logAudit({
      actorId: requester.id,
      actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
      action: 'recurring_slot.added',
      entityType: 'member',
      entityId: member_id,
      details: { day_of_week, time_start, time_end, room_id, interval_weeks: intervalWeeksNum, anchor_date: anchorDateValue, target_name: `${target.first_name || ''} ${target.last_name || ''}`.trim() },
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
