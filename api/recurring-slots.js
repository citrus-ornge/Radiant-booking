const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');
const { validateSessionBlock } = require('./_lib/sessionBlocks');
const { syncUpcomingSlotBookings } = require('./_lib/recurringBookingSync');

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
      .select('id, day_of_week, time_start, time_end, room_id, interval_weeks, anchor_date, starts_from, room:rooms(id, name)')
      .eq('member_id', memberId)
      .order('day_of_week');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ slots: data });
  }

  if (req.method === 'POST') {
    if (!isAdmin) return res.status(403).json({ error: 'Only Staff & Admin can set recurring slots' });
    const { member_id, day_of_week, time_start, time_end, room_id, interval_weeks, anchor_date, starts_from } = req.body || {};
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

    // starts_from (optional): the first real calendar date this slot is in
    // effect from — e.g. a member changing days who wants their new slot
    // to genuinely start next Monday, not retroactively cover this week.
    // Distinct from anchor_date above, which only sets every-N-week parity.
    let startsFromValue = null;
    if (starts_from) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const startsFromDayName = dayNames[new Date(starts_from + 'T00:00:00Z').getUTCDay()];
      if (startsFromDayName !== day_of_week) {
        return res.status(400).json({ error: `starts_from (${starts_from}) falls on a ${startsFromDayName}, not ${day_of_week} — pick the actual first ${day_of_week} this slot starts from` });
      }
      const todayStr = new Date().toISOString().slice(0, 10);
      if (starts_from < todayStr) {
        return res.status(400).json({ error: `starts_from (${starts_from}) is in the past` });
      }
      startsFromValue = starts_from;
    }

    const { data: target, error: targetErr } = await supabase.from('members').select('id, first_name, last_name, plan_tier').eq('id', member_id).maybeSingle();
    if (targetErr) return res.status(500).json({ error: targetErr.message });
    if (!target) return res.status(404).json({ error: 'Member not found' });

    const { data: slot, error } = await supabase
      .from('member_recurring_slots')
      .insert({ member_id, day_of_week, time_start, time_end, room_id: room_id || null, interval_weeks: intervalWeeksNum, anchor_date: anchorDateValue, starts_from: startsFromValue })
      .select('id, day_of_week, time_start, time_end, room_id, interval_weeks, anchor_date, starts_from, room:rooms(id, name)')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    await logAudit({
      actorId: requester.id,
      actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
      action: 'recurring_slot.added',
      entityType: 'member',
      entityId: member_id,
      details: { day_of_week, time_start, time_end, room_id, interval_weeks: intervalWeeksNum, anchor_date: anchorDateValue, starts_from: startsFromValue, target_name: `${target.first_name || ''} ${target.last_name || ''}`.trim() },
    });

    await syncSubscriptionAfterSlotChange(supabase, member_id);
    await syncUpcomingBookingsAfterSlotChange(supabase, member_id);

    return res.status(200).json({ slot });
  }

  if (req.method === 'DELETE') {
    if (!isAdmin) return res.status(403).json({ error: 'Only Staff & Admin can remove recurring slots' });
    const slotId = req.query.id;
    if (!slotId) return res.status(400).json({ error: 'id is required' });

    const { data: existing, error: findErr } = await supabase.from('member_recurring_slots').select('member_id, day_of_week, time_start, time_end, room_id').eq('id', slotId).maybeSingle();
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

    // The slot itself is gone, but any future real bookings that were
    // auto-created FROM it (see api/_lib/recurringBookingSync.js) would
    // otherwise keep sitting there blocking the room for a slot that no
    // longer exists — cancel exactly those (this member, this room, still
    // in the future, matching this slot's day/time). Deliberately narrow
    // rather than "any future booking for this member" — a genuine extra
    // booking they made themselves, even one that happens to share this
    // room, must not get swept up in a slot removal.
    if (existing.room_id) {
      const { data: futureOccurrences } = await supabase
        .from('bookings')
        .select('id, start_time')
        .eq('member_id', existing.member_id)
        .eq('room_id', existing.room_id)
        .neq('status', 'cancelled')
        .gt('start_time', new Date().toISOString());
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const matching = (futureOccurrences || []).filter(b => {
        const d = new Date(b.start_time);
        if (dayNames[d.getUTCDay()] !== existing.day_of_week) return false;
        const hm = d.toISOString().slice(11, 19);
        return hm === existing.time_start.slice(0, 8) || hm === existing.time_start;
      });
      if (matching.length > 0) {
        await supabase.from('bookings').update({ status: 'cancelled' }).in('id', matching.map(b => b.id));
        await logAudit({
          actorId: requester.id,
          actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
          action: 'booking.auto_cancelled_slot_removed',
          entityType: 'member', entityId: existing.member_id,
          details: { count: matching.length, dates: matching.map(b => b.start_time) },
        });
      }
    }

    await syncSubscriptionAfterSlotChange(supabase, existing.member_id);

    return res.status(200).json({ deleted: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

// Real gap found 4 Sep 2026: adding/removing a recurring slot never used to
// touch billing at all — the calendar and profile would show the new
// schedule immediately, but an existing GoCardless subscription just kept
// charging whatever it was already set to, forever. Called after every
// add/remove so the fee actually matches the schedule the member can see.
// Silent on skip/no-op (no existing subscription yet, fee unchanged,
// Community/Flex) — only logs when the amount genuinely changes or the
// GoCardless call fails, since those are the only outcomes worth an admin
// knowing about.
async function syncSubscriptionAfterSlotChange(supabase, memberId) {
  const { data: member, error } = await supabase
    .from('members')
    .select('id, first_name, last_name, plan_tier, gocardless_subscription_id, custom_monthly_fee_pence')
    .eq('id', memberId)
    .maybeSingle();
  if (error || !member) return;

  let syncMembershipSubscriptionAmount;
  try {
    ({ syncMembershipSubscriptionAmount } = require('./_lib/gocardless'));
  } catch (e) {
    console.error(`Payments not configured — couldn't sync subscription amount for member ${memberId}:`, e.message);
    return;
  }

  const result = await syncMembershipSubscriptionAmount(supabase, member);
  const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.id;

  if (result.updated) {
    await logAudit({
      actorId: null, actorName: 'System (slot change)', action: 'billing.subscription_amount_synced',
      entityType: 'member', entityId: member.id,
      details: { from_pence: result.fromPence, to_pence: result.toPence, trigger: 'recurring_slot_change' },
    });
  } else if (result.failed) {
    console.error(`Failed to sync subscription amount for ${memberName} (${member.id}) after slot change:`, result.error);
  }
}

// Populates the rolling window of real, calendar-blocking bookings for a
// member's slots the moment one is added — see
// api/_lib/recurringBookingSync.js for why this exists at all (a recurring
// slot never used to create any actual booking beyond whichever single
// week someone happened to book by hand). Errors logged, not surfaced to
// the admin's request — adding the slot itself already succeeded, and
// clashes/failures here are things to review, not reasons to fail the add.
async function syncUpcomingBookingsAfterSlotChange(supabase, memberId) {
  const { data: member, error } = await supabase.from('members').select('id, plan_tier').eq('id', memberId).maybeSingle();
  if (error || !member) return;
  try {
    const result = await syncUpcomingSlotBookings(supabase, member);
    if (result.skippedClashes.length > 0 || result.failed.length > 0) {
      console.error(`Recurring slot sync for member ${memberId}: ${result.created.length} created, ${result.skippedClashes.length} clashes skipped, ${result.failed.length} failed`, result.skippedClashes, result.failed);
    }
  } catch (e) {
    console.error(`Recurring slot booking sync failed for member ${memberId}:`, e.message);
  }
}
