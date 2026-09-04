const { logAudit } = require('./audit');
const { isSlotOccurrenceIncluded } = require('./pricing');

// Real gap found 4 Sep 2026: a Core/Resident member's recurring slot
// (member_recurring_slots) has only ever been a PRICING rule — "if a
// booking happens to land in this day/time, don't charge for it." Nothing
// ever actually created the booking itself. So a member's regular slot
// never showed on the calendar and never blocked the room for anyone else
// booking it, except for whichever single week someone happened to book
// by hand (usually just their very first session, created during
// onboarding). Every Core/Resident member except one had zero real
// bookings on record for their slot.
//
// This keeps a rolling window of real, confirmed booking rows in
// existence for every agreed slot occurrence — so the calendar and the
// room's availability are always correct that far ahead, without anyone
// needing to manually re-book the same standing session every single
// week. Called right when a slot is added (so it's not empty until the
// next cron run) and again daily from a cron (so the window keeps
// sliding forward as time passes and new starts_from dates arrive).
const ROLLING_WINDOW_DAYS = 84; // ~12 weeks — comfortably beyond any member-facing booking-ahead limit (30 days), so the diary is reliably blocked well in advance of anyone trying to book over it

// Returns { created: [...datesISO], skippedClashes: [...datesISO], failed: [{date, error}] }
async function syncUpcomingSlotBookings(supabase, member) {
  const result = { created: [], skippedClashes: [], failed: [] };
  if (!['core', 'resident'].includes(member.plan_tier)) return result;

  const { data: slots, error: slotsErr } = await supabase
    .from('member_recurring_slots')
    .select('id, day_of_week, time_start, time_end, room_id, interval_weeks, anchor_date, starts_from')
    .eq('member_id', member.id);
  if (slotsErr || !slots || slots.length === 0) return result;

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const windowEnd = new Date(today.getTime() + ROLLING_WINDOW_DAYS * 86400000);

  for (const slot of slots) {
    if (!slot.room_id) continue; // no room agreed yet — nothing to book against
    const targetDayIdx = dayNames.indexOf(slot.day_of_week);
    if (targetDayIdx < 0) continue;

    // Walk every real calendar date of that weekday between today and the
    // end of the rolling window.
    const cursor = new Date(today);
    const offset = (targetDayIdx - cursor.getUTCDay() + 7) % 7;
    cursor.setUTCDate(cursor.getUTCDate() + offset);

    for (; cursor <= windowEnd; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
      const dateStr = cursor.toISOString().slice(0, 10);
      if (!isSlotOccurrenceIncluded(slot, dateStr)) continue; // not a real occurrence this week (every-N-week parity or before starts_from)

      const startISO = `${dateStr}T${slot.time_start}Z`;
      const endISO = `${dateStr}T${slot.time_end}Z`;

      try {
        // Already got a real booking for this exact slot occurrence? Don't
        // duplicate — covers both a prior run of this same sync and a
        // manually-created booking (e.g. their actual first session,
        // created during onboarding).
        const { data: existing, error: existingErr } = await supabase
          .from('bookings')
          .select('id')
          .eq('member_id', member.id)
          .eq('room_id', slot.room_id)
          .eq('start_time', new Date(startISO).toISOString())
          .neq('status', 'cancelled')
          .maybeSingle();
        if (existingErr) { result.failed.push({ date: dateStr, error: existingErr.message }); continue; }
        if (existing) continue;

        // Someone/something else already has this room for part of this
        // window (another member's ad-hoc booking, an admin room block) —
        // don't silently overwrite a real conflict; skip and let it
        // surface to admin instead, same principle as a normal booking
        // attempt hitting a genuine clash.
        const { data: clash, error: clashErr } = await supabase
          .from('bookings')
          .select('id')
          .eq('room_id', slot.room_id)
          .neq('status', 'cancelled')
          .lt('start_time', endISO)
          .gt('end_time', startISO);
        if (clashErr) { result.failed.push({ date: dateStr, error: clashErr.message }); continue; }
        if (clash && clash.length > 0) { result.skippedClashes.push(dateStr); continue; }

        // This IS one of the member's own agreed slot occurrences, so it's
        // free under their membership fee — UNLESS it's genuinely their
        // very first booking ever and it's happening within a week (same
        // rule as a manually-created booking would apply — Rosie, 4 Sep
        // 2026: Direct Debit can take up to 5 days, so a first session
        // this soon shouldn't ride on a subscription that may not be
        // collecting yet). Checked fresh each time through the loop since
        // the very first occurrence created flips this for every one after it.
        let paymentStatus = 'not_required';
        const daysUntilSession = (new Date(startISO) - new Date()) / 86400000;
        if (daysUntilSession < 7) {
          const { count: priorCount, error: priorErr } = await supabase
            .from('bookings')
            .select('id', { count: 'exact', head: true })
            .eq('member_id', member.id)
            .neq('status', 'cancelled');
          if (priorErr) { result.failed.push({ date: dateStr, error: priorErr.message }); continue; }
          if (!priorCount || priorCount === 0) {
            // Genuine first-ever booking, happening soon — charge it like
            // any other chargeable session rather than auto-marking it free.
            // This mirrors, deliberately not duplicates the full pricing
            // call, since a same-session direct API booking would still be
            // the primary path for a member's actual first booking in
            // practice — this only guards the rare case where the very
            // first occurrence in the window happens to get auto-created
            // here first. Left as 'pending_manual' rather than guessing an
            // amount, so admin sets the real charge rather than this
            // silently skipping it.
            paymentStatus = 'pending_manual';
          }
        }

        const { data: booking, error: insertErr } = await supabase
          .from('bookings')
          .insert({
            member_id: member.id, room_id: slot.room_id,
            start_time: startISO, end_time: endISO,
            status: 'confirmed', payment_status: paymentStatus,
          })
          .select('id')
          .single();
        if (insertErr) { result.failed.push({ date: dateStr, error: insertErr.message }); continue; }

        await logAudit({
          actorId: null, actorName: 'System (recurring slot sync)', action: 'booking.auto_created_from_slot',
          entityType: 'booking', entityId: booking.id,
          details: { member_id: member.id, slot_id: slot.id, date: dateStr, payment_status: paymentStatus },
        });
        result.created.push(dateStr);
      } catch (e) {
        result.failed.push({ date: dateStr, error: e.message });
      }
    }
  }

  return result;
}

module.exports = { syncUpcomingSlotBookings, ROLLING_WINDOW_DAYS };
