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
        plan_tier: invite.plan_tier || null,
        plan_tier_started_at: ['core', 'resident'].includes(invite.plan_tier) ? new Date().toISOString() : null,
        custom_monthly_fee_pence: invite.custom_monthly_fee_pence ?? null,
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
        plan_tier: invite.plan_tier || null,
        plan_tier_started_at: ['core', 'resident'].includes(invite.plan_tier) ? new Date().toISOString() : null,
        custom_monthly_fee_pence: invite.custom_monthly_fee_pence ?? null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    member = data;
  }

  await supabase.from('invites').update({ status: 'accepted' }).eq('id', invite.id);

  // An invite can offer more than one recurring slot (e.g. full day Monday
  // + half day Friday) — reserved_slots is a JSON array of
  // { day_of_week, time_start, time_end, room_id }. Guarded against
  // duplicating if this invite is somehow accepted twice for an existing
  // member who already has slots.
  const inviteSlots = Array.isArray(invite.reserved_slots) ? invite.reserved_slots : [];
  if (inviteSlots.length > 0) {
    const { data: alreadyHasSlots } = await supabase.from('member_recurring_slots').select('id').eq('member_id', member.id).limit(1);
    if (!alreadyHasSlots || alreadyHasSlots.length === 0) {
      await supabase.from('member_recurring_slots').insert(
        inviteSlots.map(s => ({
          member_id: member.id,
          day_of_week: s.day_of_week,
          time_start: s.time_start,
          time_end: s.time_end,
          room_id: s.room_id || null,
        }))
      );
    }
  }

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
