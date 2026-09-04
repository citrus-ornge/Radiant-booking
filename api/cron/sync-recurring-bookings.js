const { getSupabase } = require('../_lib/supabase');
const { syncUpcomingSlotBookings } = require('../_lib/recurringBookingSync');

// Vercel Cron calls this daily. Keeps sliding the rolling window (see
// ROLLING_WINDOW_DAYS in _lib/recurringBookingSync.js) forward — the
// immediate sync when a slot is added covers the window as of that
// moment, this is what extends it as each day passes and new occurrences
// enter the window (and as any starts_from date for a not-yet-started
// slot arrives).
module.exports = async (req, res) => {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const { data: members, error } = await supabase
    .from('members')
    .select('id, plan_tier')
    .in('plan_tier', ['core', 'resident'])
    .eq('status', 'active');
  if (error) return res.status(500).json({ error: error.message });

  const results = { members_checked: 0, created: 0, skipped_clashes: 0, failed: 0 };
  for (const member of members || []) {
    results.members_checked++;
    try {
      const result = await syncUpcomingSlotBookings(supabase, member);
      results.created += result.created.length;
      results.skipped_clashes += result.skippedClashes.length;
      results.failed += result.failed.length;
    } catch (e) {
      results.failed++;
      console.error(`Recurring booking sync failed for member ${member.id}:`, e.message);
    }
  }

  return res.status(200).json(results);
};
