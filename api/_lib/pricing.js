// Server-side mirror of the per-session rates shown in TIER_DATA in
// index.html (Membership & Pricing page). Amounts in pence. This is the
// authoritative source for what a booking actually gets charged — never
// trust a price sent from the client.
//
// IMPORTANT: keep this in sync with TIER_DATA by hand. If the brochure rates
// change, update both places.
//
// KNOWN GAP: the brochure only prices 1 Hour, 2 Hours, and Half Day (4hrs)
// per session — there's no defined single-session rate for a 3-hour booking
// or a full day (8hrs), even though both are options in the booking form's
// Duration dropdown. calculateSessionChargeInPence returns null for these
// rather than guessing a number, and callers must treat null as "route to
// manual invoicing", never as "free" or "estimate it".
const RATES_PENCE_BY_DURATION_MINUTES = {
  community: { 60: [2000, 1700], 120: [3500, 3000], 240: [4750, 4000] },
  flex:      { 60: [1800, 1500], 120: [3200, 2700], 240: [4500, 3750] },
  core:      { 60: [1700, 1400], 120: [2900, 2600], 240: [4250, 3500] },
  resident:  { 60: [1500, 1200], 120: [3000, 2400], 240: [4000, 3250] },
};
// Tuple index within each duration bracket above: [clinical_wellness, consultation]
const CATEGORY_INDEX = { clinical_wellness: 0, consultation: 1 };

// Returns the price in pence for one session, or null if this exact
// combination isn't priced in the brochure (unknown tier, unpriced
// duration, or the room has no pricing_category set yet).
function calculateSessionChargeInPence(planTier, durationMinutes, pricingCategory) {
  const tierRates = RATES_PENCE_BY_DURATION_MINUTES[planTier];
  if (!tierRates) return null;
  const bracket = tierRates[durationMinutes];
  if (!bracket) return null;
  const idx = CATEGORY_INDEX[pricingCategory];
  if (idx === undefined) return null;
  return bracket[idx];
}

module.exports = { calculateSessionChargeInPence, RATES_PENCE_BY_DURATION_MINUTES, isIncludedInMembershipFee, isSlotOccurrenceIncluded };

// Whether a given calendar date is actually an "occurrence" of a recurring
// slot — team review 26 Aug 2026: practitioners can agree a slot that
// repeats every N weeks (weekly=1, fortnightly=2, every 3rd week=3, etc.),
// not just every single week. anchor_date is the slot's agreed first
// occurrence (always on the same day_of_week as the slot itself); a later
// date counts only if the whole number of weeks since that anchor is an
// exact multiple of interval_weeks. interval_weeks===1 (the original,
// still-default case) always returns true regardless of anchor_date,
// matching the exact old "every single week" behaviour for any slot that
// hasn't set a different interval.
function isSlotOccurrenceIncluded(slot, dateOrISOString) {
  if (!slot.interval_weeks || slot.interval_weeks <= 1) return true;
  if (!slot.anchor_date) return true; // shouldn't happen given validation, but don't wrongly exclude on missing data
  const anchor = new Date(slot.anchor_date + 'T00:00:00Z');
  const target = new Date(dateOrISOString);
  const msPerWeek = 7 * 24 * 3600 * 1000;
  const weeksBetween = Math.round((target - anchor) / msPerWeek);
  return ((weeksBetween % slot.interval_weeks) + slot.interval_weeks) % slot.interval_weeks === 0;
}

// Whether a Core/Resident booking is covered by their flat monthly fee
// (one of their included recurring slots — they can have more than one,
// e.g. a full day Monday plus a half day Friday) rather than being an extra
// chargeable session. ASSUMPTION (flag for Radiant to confirm): "included"
// means the *first* booking each week that lands in that exact slot's
// room + day + time window; anything beyond that — a second booking that
// week in the same slot, a different room, or outside any agreed slot's
// time window — is charged per session like a Flex booking would be.
async function isIncludedInMembershipFee(supabase, member, slots, { room_id, start_time }) {
  if (!['core', 'resident'].includes(member.plan_tier)) return false;
  if (!slots || slots.length === 0) return false;

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const start = new Date(start_time);
  const dayName = dayNames[start.getDay()];
  const timeOfDay = start.toISOString().slice(11, 19); // HH:MM:SS (UTC — matches how time_start/time_end are stored)

  const matchingSlot = slots.find(s => s.room_id === room_id && s.day_of_week === dayName && timeOfDay >= s.time_start && timeOfDay < s.time_end);
  if (!matchingSlot) return false;
  // Even/odd-week (or every-3rd/4th-week) slots aren't included on a week
  // that isn't actually one of their agreed occurrences — those weeks are
  // a genuine chargeable extra, exactly like booking outside the slot
  // entirely.
  if (!isSlotOccurrenceIncluded(matchingSlot, start_time)) return false;

  // Monday-start week boundary containing this booking.
  const weekStart = new Date(start);
  const isoDow = (start.getDay() + 6) % 7; // 0=Mon..6=Sun
  weekStart.setUTCHours(0, 0, 0, 0);
  weekStart.setUTCDate(weekStart.getUTCDate() - isoDow);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

  const { data: existing, error } = await supabase
    .from('bookings')
    .select('id, start_time')
    .eq('member_id', member.id)
    .eq('room_id', matchingSlot.room_id)
    .eq('is_topup', false)
    .neq('status', 'cancelled')
    .gte('start_time', weekStart.toISOString())
    .lt('start_time', weekEnd.toISOString());
  if (error) throw new Error(error.message);

  // Only count existing bookings that land on the SAME day-of-week as this
  // slot — a member with slots in the same room on two different days
  // shouldn't have Monday's booking count against Friday's eligibility.
  const matchingExisting = (existing || []).filter(b => dayNames[new Date(b.start_time).getDay()] === matchingSlot.day_of_week);
  return matchingExisting.length === 0;
}
