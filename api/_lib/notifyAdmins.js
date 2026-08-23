const { sendAdminAlertEmail } = require('./email');

// Notifies every active Staff & Admin member of something needing their
// attention — both an in-app message (Messages inbox) and a real email.
//
// Replaces 5 separate copies of "loop over active admins, insert a
// message" that had built up across the codebase (subscription creation
// failures, subscription payment failures, a stuck mandate, a declined
// room offer) — every one of them only ever showed in-app before 22 Aug
// 2026, relying entirely on someone happening to check Messages. Team
// decided all admin alerts should also email, not just this one case.
// Centralised here so a future 6th alert doesn't have to remember to
// re-implement both the in-app and email side separately.
//
// relatedMemberId is whoever the alert is ABOUT (e.g. the member whose
// payment failed) — used as sender_id on the message row for context/
// linking, same as the pattern already established at every call site
// this replaces. It is NOT who the alert is FOR (that's always every
// active admin).
async function notifyAdmins(supabase, { relatedMemberId, subject, body }) {
  const { data: admins, error } = await supabase
    .from('members')
    .select('id, first_name, email')
    .eq('user_type', 'administrator')
    .eq('status', 'active');
  if (error) { console.error('notifyAdmins: failed to fetch admins:', error.message); return; }

  for (const admin of admins || []) {
    try {
      await supabase.from('messages').insert({ sender_id: relatedMemberId, recipient_id: admin.id, body });
    } catch (e) {
      console.error(`notifyAdmins: failed to insert in-app message for admin ${admin.id}:`, e.message);
    }
    if (admin.email) {
      try {
        await sendAdminAlertEmail({ to: admin.email, adminName: admin.first_name || 'there', subject, body });
      } catch (e) {
        // Email failing shouldn't be treated as the alert failing — the
        // in-app message above already landed either way.
        console.error(`notifyAdmins: failed to send alert email to ${admin.email}:`, e.message);
      }
    }
  }
}

module.exports = { notifyAdmins };
