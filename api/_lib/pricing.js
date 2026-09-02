// Server-side mirror of the per-session rates shown in TIER_DATA in
// index.html (Membership & Pricing page). Amounts in pence. This is the
// authoritative source for what a booking actually gets charged — never
// trust a price sent from the client.
//
// IMPORTANT: keep this in sync with TIER_DATA by hand. If the brochure rates
// change, update both places.
//
// KNOWN GAP: the brochure only prices 1 Hour, 2 Hours, Half Day, and Full
// Day per session — there's still no defined single-session rate for a
// 3-hour booking, even though it's an option in the booking form's
// Duration dropdown. calculateSessionChargeInPence returns null for this
// rather than guessing a number, and callers must treat null as "route to
// manual invoicing", never as "free" or "estimate it".
// Team review: ad-hoc Half day/Full day now mean the exact same fixed
// blocks as Core/Resident recurring slots (8am-1pm/1pm-6pm = 5hrs=300min,
// 8am-6pm = 10hrs=600min) — previously keyed to 240min (4hrs), with no
// price at all for Full day, meaning every single ad-hoc Full day (and
// 3hr) booking fell back to a manual invoice rather than being charged
// automatically. Values sourced directly from the published Membership &
// Pricing rates (index.html TIER_DATA, the canonical reference for all
// pricing math) — confirmed the existing 240min figures already exactly
// matched "Half Day (50%)" for every tier, so they carry over unchanged
// to the new 300min key; "1 Day/Week" is the matching source for the new
// 600min (Full day) entries, which for Core/Resident also exactly
// matches their existing recurring-slot full-day weekly rate.
const RATES_PENCE_BY_DURATION_MINUTES = {
  community: { 60: [2000, 1700], 120: [3500, 3000], 300: [4750, 4000], 600: [9500, 8000] },
  flex:      { 60: [1800, 1500], 120: [3200, 2700], 300: [4500, 3750], 600: [9000, 7500] },
  core:      { 60: [1700, 1400], 120: [2900, 2600], 300: [4250, 3500], 600: [8500, 7000] },
  resident:  { 60: [1500, 1200], 120: [3000, 2400], 300: [4000, 3250], 600: [8000, 6500] },
};
// Tuple index within each duration bracket above: [clinical_wellness, consultation]
const CATEGORY_INDEX = { clinical_wellness: 0, consultation: 1 };

// Returns the price in pence for one session, or null if this exact
// combination isn't priced in the brochure (unknown tier, unpriced
// duration, or the room has no pricing_category set yet).
// Evening Sessions (team review): flat £35, any tier, any room category,
// no discounts at all — but only for the actual defined evening slot
// itself (exactly a 2-hour booking, Thursdays/Fridays 6-8pm) — confirmed
// directly: "only 2 hours at £35 is the evening slot no matter what",
// anything else reverts to normal tier-based pricing. Uses Europe/London
// LOCAL time to determine day-of-week and hour, not raw UTC — the same
// lesson as the earlier live timezone bug (a booking near midnight UTC
// could otherwise land on the wrong calendar day, or the wrong side of
// 6pm, during British Summer Time).
const EVENING_SESSION_FEE_PENCE = 3500;
// Evening Sessions (team review follow-up): "the [day] is irrelevant, if
// they are booking evening 6pm onwards it's £35" — confirmed explicitly:
// any day of the week now, not just Thursdays/Fridays, but still exactly
// the 2-hour, 6-8pm window. Uses Europe/London LOCAL time to determine
// the hour, not raw UTC — the same lesson as the earlier live timezone
// bug (a booking near midnight UTC could otherwise land on the wrong
// side of 6pm during British Summer Time).
function isEveningSessionBooking(startTimeISO, durationMinutes) {
  if (durationMinutes !== 120 || !startTimeISO) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(startTimeISO));
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  return hour >= 18 && hour < 20;
}

function calculateSessionChargeInPence(planTier, durationMinutes, pricingCategory, startTimeISO) {
  if (isEveningSessionBooking(startTimeISO, durationMinutes)) return EVENING_SESSION_FEE_PENCE;
  const tierRates = RATES_PENCE_BY_DURATION_MINUTES[planTier];
  if (!tierRates) return null;
  const bracket = tierRates[durationMinutes];
  if (!bracket) return null;
  const idx = CATEGORY_INDEX[pricingCategory];
  if (idx === undefined) return null;
  return bracket[idx];
}

module.exports = { calculateSessionChargeInPence, RATES_PENCE_BY_DURATION_MINUTES, isIncludedInMembershipFee, isSlotOccurrenceIncluded, isEveningSessionBooking };

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
