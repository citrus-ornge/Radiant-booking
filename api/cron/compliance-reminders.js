const { getSupabase } = require('../_lib/supabase');
const { sendComplianceDocsReminderEmail } = require('../_lib/email');
const { notifyAdmins } = require('../_lib/notifyAdmins');

// Vercel Cron calls this on the schedule set in vercel.json (daily).
// Guarded by CRON_SECRET so it can't be triggered by randoms hitting the URL.
//
// Team review 26 Aug 2026: "ID and docs is mandatory (insurance) so must
// have way to ensure uploaded. Not on initial onboarding or before DD set
// up" — decided against any hard block and went with a persistent
// reminder instead: starting 48 hours after a practitioner joins, if
// they're still missing proof of ID or insurance/indemnity, both the
// practitioner AND every admin get a reminder email — at most once per
// day, tracked via compliance_docs_reminder_last_sent_at, so this cron
// can safely run more often than the reminder cadence itself without
// spamming anyone.
const GRACE_PERIOD_HOURS = 48;
const REMINDER_INTERVAL_HOURS = 24;

module.exports = async (req, res) => {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const now = new Date();
  const results = { checked: 0, reminders_sent: 0, errors: [] };

  const { data: practitioners, error } = await supabase
    .from('members')
    .select('id, first_name, last_name, email, created_at, compliance_docs_reminder_last_sent_at')
    .eq('user_type', 'practitioner')
    .eq('status', 'active');
  if (error) return res.status(500).json({ error: error.message });

  for (const m of practitioners || []) {
    results.checked++;
    try {
      const joinedHoursAgo = (now - new Date(m.created_at)) / 3600000;
      if (joinedHoursAgo < GRACE_PERIOD_HOURS) continue;

      const lastSent = m.compliance_docs_reminder_last_sent_at ? new Date(m.compliance_docs_reminder_last_sent_at) : null;
      if (lastSent && (now - lastSent) / 3600000 < REMINDER_INTERVAL_HOURS) continue;

      const { data: docs } = await supabase
        .from('member_documents')
        .select('document_type')
        .eq('member_id', m.id)
        .in('document_type', ['id_proof', 'insurance']);
      const types = new Set((docs || []).map(d => d.document_type));
      const missing = [];
      if (!types.has('id_proof')) missing.push('proof of ID');
      if (!types.has('insurance')) missing.push('insurance/indemnity certificate');
      if (missing.length === 0) continue; // already complete — nothing to remind about

      const memberName = `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.email;
      if (m.email) {
        await sendComplianceDocsReminderEmail({ to: m.email, memberName });
      }
      await notifyAdmins(supabase, {
        relatedMemberId: m.id,
        subject: `⚠ ${memberName} is still missing mandatory compliance documents`,
        body: `${memberName} joined ${Math.floor(joinedHoursAgo / 24)} day(s) ago and is still missing: ${missing.join(', ')}.`,
      });

      await supabase.from('members').update({ compliance_docs_reminder_last_sent_at: now.toISOString() }).eq('id', m.id);
      results.reminders_sent++;
    } catch (e) {
      results.errors.push(`compliance reminder for member ${m.id}: ${e.message}`);
    }
  }

  res.status(200).json(results);
};
