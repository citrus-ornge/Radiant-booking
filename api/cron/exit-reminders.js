const { getSupabase } = require('../_lib/supabase');
const { sendExitNoticeReminder } = require('../_lib/email');

// Vercel Cron calls this on the schedule set in vercel.json (daily).
// Guarded by CRON_SECRET so it can't be triggered by randoms hitting the URL.
//
// Core and Resident members are on a recurring fixed-term cycle (3 months /
// 6 months) and must give written notice (30 days / 60 days respectively)
// before the end of a cycle if they want to leave. We send a reminder email
// 14 days before that notice deadline — i.e. (noticeDays + 14) days before
// the cycle actually ends — so they have a clear window to act.
//
// plan_tier_started_at is the anchor date for the very first cycle; we walk
// forward in term-length steps to find the current/next cycle boundary,
// which means this keeps working correctly cycle after cycle without any
// manual reset, as long as the membership keeps auto-renewing.

const TERM_MONTHS = { core: 3, resident: 6 };
const NOTICE_DAYS = { core: 30, resident: 60 };
const REMINDER_LEAD_DAYS = 14;

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

module.exports = async (req, res) => {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const now = new Date();
  const results = { checked: 0, reminders_sent: 0, errors: [] };

  const { data: members, error } = await supabase
    .from('members')
    .select('id, first_name, last_name, email, plan_tier, plan_tier_started_at, exit_reminder_sent_for_cycle_end, status')
    .in('plan_tier', ['core', 'resident'])
    .eq('status', 'active')
    .not('plan_tier_started_at', 'is', null);

  if (error) return res.status(500).json({ error: error.message });

  for (const m of members || []) {
    results.checked++;
    try {
      const termMonths = TERM_MONTHS[m.plan_tier];
      const noticeDays = NOTICE_DAYS[m.plan_tier];
      const startDate = new Date(m.plan_tier_started_at);

      // Walk forward to find the current/next cycle end at or after today
      let cycleEnd = addMonths(startDate, termMonths);
      let guard = 0;
      while (cycleEnd < now && guard < 240) {
        cycleEnd = addMonths(cycleEnd, termMonths);
        guard++;
      }

      const noticeDeadline = addDays(cycleEnd, -noticeDays);
      const reminderDate = addDays(noticeDeadline, -REMINDER_LEAD_DAYS);
      const cycleEndDateStr = cycleEnd.toISOString().slice(0, 10);

      const alreadySent = m.exit_reminder_sent_for_cycle_end === cycleEndDateStr;
      if (!alreadySent && isSameCalendarDay(now, reminderDate)) {
        await sendExitNoticeReminder({
          to: m.email,
          memberName: `${m.first_name} ${m.last_name}`.trim() || m.email,
          planTier: m.plan_tier,
          noticeDays,
          cycleEndDate: cycleEnd.toISOString(),
          noticeDeadlineDate: noticeDeadline.toISOString(),
        });
        await supabase.from('members').update({ exit_reminder_sent_for_cycle_end: cycleEndDateStr }).eq('id', m.id);
        results.reminders_sent++;
      }
    } catch (e) {
      results.errors.push(`exit reminder for member ${m.id}: ${e.message}`);
    }
  }

  res.status(200).json(results);
};
