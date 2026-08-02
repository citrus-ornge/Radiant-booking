const { createClient } = require('@supabase/supabase-js');
const { getSupabase } = require('../_lib/supabase');
const { sendWelcomeEmail } = require('../_lib/email');

const SUPABASE_URL = 'https://lygzlpeslpwptjqxtjgs.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_zHXuiXcq7UGXRDeTtMAfgA_NVTwpsSA';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { token } = req.body || {};
  const authHeader = req.headers['authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token || !accessToken) return res.status(400).json({ error: 'token and Authorization bearer are required' });

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await authClient.auth.getUser(accessToken);
  if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'Invalid or expired session' });
  const authUser = userData.user;

  const supabase = getSupabase();
  const { data: invite, error: inviteErr } = await supabase
    .from('invites')
    .select('*')
    .eq('token', token)
    .maybeSingle();
  if (inviteErr) return res.status(500).json({ error: inviteErr.message });
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.status === 'accepted') return res.status(410).json({ error: 'This invite has already been used' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'This invite has expired' });
  if (invite.email.toLowerCase() !== (authUser.email || '').toLowerCase()) {
    return res.status(403).json({ error: 'This invite was issued to a different email address' });
  }

  // Link to an existing member row with this email if one exists, otherwise create one
  const { data: existing } = await supabase.from('members').select('id').eq('email', invite.email).maybeSingle();

  let member;
  if (existing) {
    const { data, error } = await supabase
      .from('members')
      .update({
        auth_user_id: authUser.id, status: 'active',
        is_owner: invite.is_owner,
        onboarding_status: invite.is_owner ? 'completed' : 'profile_pending',
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    member = data;
  } else {
    const { data, error } = await supabase
      .from('members')
      .insert({
        first_name: '', last_name: '', email: invite.email,
        user_type: invite.user_type, auth_user_id: authUser.id,
        is_owner: invite.is_owner,
        onboarding_status: invite.is_owner ? 'completed' : 'profile_pending',
        status: 'active',
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    member = data;
  }

  await supabase.from('invites').update({ status: 'accepted' }).eq('id', invite.id);

  let welcome_email_sent = false;
  try {
    await sendWelcomeEmail({
      to: member.email,
      firstName: member.first_name || member.email.split('@')[0],
      userType: member.user_type,
      planTier: member.plan_tier,
      directoryTier: member.directory_tier,
      isOwner: member.is_owner,
    });
    welcome_email_sent = true;
  } catch (e) {
    // don't fail account creation over a welcome email issue
  }

  res.status(200).json({ member, welcome_email_sent });
};
