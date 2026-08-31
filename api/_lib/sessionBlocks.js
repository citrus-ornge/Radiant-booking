// Single source of truth for what a valid Core/Resident recurring slot
// looks like. Team review (Rosie, via direct confirmation) — this is
// fixed, standard-timetable pricing, not a flexible hourly-start model:
// Half day is 8am-1pm or 1pm-6pm (5 real hours each), Full day is
// 8am-6pm (10 real hours). No other start times or lengths are valid.
const VALID_SESSION_BLOCKS = {
  '08:00': '13:00', // Half day (morning)
  '13:00': '18:00', // Half day (afternoon)
  // '08:00': '18:00' would collide with the morning half-day key above,
  // so Full day is checked separately below rather than folded into this map.
};
const FULL_DAY_BLOCK = { start: '08:00', end: '18:00' };

// Returns null if valid, or an error string describing what's wrong.
function validateSessionBlock(time_start, time_end) {
  if (time_start === FULL_DAY_BLOCK.start && time_end === FULL_DAY_BLOCK.end) return null;
  if (VALID_SESSION_BLOCKS[time_start] === time_end) return null;
  return `must be exactly a half day (8am-1pm or 1pm-6pm) or full day (8am-6pm) — ${time_start}–${time_end} isn't`;
}

module.exports = { VALID_SESSION_BLOCKS, FULL_DAY_BLOCK, validateSessionBlock };
