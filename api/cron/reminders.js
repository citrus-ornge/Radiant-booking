const { getSupabase } = require('../_lib/supabase');
const { sendReminder } = require('../_lib/email');

// Vercel Cron calls this on the schedule set in vercel.json (hourly).
// Guarded by CRON_SECRET so it can't be triggered by randoms hitting the URL.
module.exports = async (req, res) => {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const now = new Date();
  const in23to25h = [new Date(now.getTime() + 23 * 3600e3), new Date(now.getTime() + 25 * 3600e3)];
  const in0to1h = [now, new Date(now.getTime() + 1 * 3600e3)];

  const results = { reminders_24h: 0, reminders_1h: 0, errors: [] };

  // 24h reminders
  const { data: due24h } = await supabase
    .from('bookings')
    .select('id, start_time, room:rooms(name), member:members(first_name,last_name,email)')
    .eq('status', 'confirmed')
    .eq('reminder_24h_sent', false)
    .gte('start_time', in23to25h[0].toISOString())
    .lte('start_time', in23to25h[1].toISOString());

  for (const b of due24h || []) {
    try {
      await sendReminder({
        to: b.member.email,
        memberName: `${b.member.first_name} ${b.member.last_name}`,
        roomName: b.room.name,
        start: b.start_time,
        hoursBefore: '24 hours',
      });
      await supabase.from('bookings').update({ reminder_24h_sent: true }).eq('id', b.id);
      results.reminders_24h++;
    } catch (e) {
      results.errors.push(`24h reminder for booking ${b.id}: ${e.message}`);
    }
  }

  // 1h reminders
  const { data: due1h } = await supabase
    .from('bookings')
    .select('id, start_time, room:rooms(name), member:members(first_name,last_name,email)')
    .eq('status', 'confirmed')
    .eq('reminder_1h_sent', false)
    .gte('start_time', in0to1h[0].toISOString())
    .lte('start_time', in0to1h[1].toISOString());

  for (const b of due1h || []) {
    try {
      await sendReminder({
        to: b.member.email,
        memberName: `${b.member.first_name} ${b.member.last_name}`,
        roomName: b.room.name,
        start: b.start_time,
        hoursBefore: '1 hour',
      });
      await supabase.from('bookings').update({ reminder_1h_sent: true }).eq('id', b.id);
      results.reminders_1h++;
    } catch (e) {
      results.errors.push(`1h reminder for booking ${b.id}: ${e.message}`);
    }
  }

  res.status(200).json(results);
};
