const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');
const { sendPasswordResetEmail } = require('./_lib/email');

// POST /api/members-reset-password { member_id }
// Admin-only. For someone who already has an account but is stuck getting
// back in (forgotten password, etc.) — distinct from members-create.js,
// which is for setting up a brand new account. Reuses the exact same
// Supabase admin.generateLink('recovery') mechanism, just triggered by an
// admin on the member's behalf rather than requiring them to use "Forgot
// Password" themselves.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }
  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Only Staff & Admin can do this' });
  }

  const { member_id } = req.body || {};
  if (!member_id) return res.status(400).json({ error: 'member_id is required' });

  const supabase = getSupabase();
  const { data: member, error: memberErr } = await supabase.from('members').select('id, email, first_name, auth_user_id').eq('id', member_id).maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: 'Member not found' });
  if (!member.auth_user_id) return res.status(400).json({ error: 'This person doesn\'t have a login account yet — use Invite or Add User instead.' });

  const baseUrl = process.env.PUBLIC_APP_URL || 'https://booking.radiantfr.com';
  try {
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'recovery', email: member.email, options: { redirectTo: baseUrl },
    });
    if (linkErr) throw linkErr;
    await sendPasswordResetEmail({ to: member.email, firstName: member.first_name || 'there', actionLink: linkData.properties.action_link });
  } catch (e) {
    return res.status(502).json({ error: `Could not send the reset email: ${e.message}` });
  }

  await logAudit({
    actorId: requester.id,
    actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
    action: 'member.password_reset_sent',
    entityType: 'member',
    entityId: member.id,
    details: {},
  });

  return res.status(200).json({ email_sent: true });
};
