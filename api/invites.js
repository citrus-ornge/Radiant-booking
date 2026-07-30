const { getSupabase } = require('./_lib/supabase');
const { sendInvite } = require('./_lib/email');
const { requireAuth } = require('./_lib/auth');
const { checkRateLimit } = require('./_lib/rateLimit');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    // Public invite lookup by token (used by the sign-up page): /api/invites?token=xxx
    // Intentionally unauthenticated — this is how a not-yet-registered
    // practitioner verifies their invite before creating an account.
    if (req.query && req.query.token) {
      const { data: invite, error } = await supabase
        .from('invites')
        .select('email, user_type, personal_note, status, expires_at')
        .eq('token', req.query.token)
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!invite) return res.status(404).json({ error: 'Invite not found' });
      if (invite.status === 'accepted') return res.status(410).json({ error: 'This invite has already been used' });
      if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'This invite has expired' });
      return res.status(200).json({ invite });
    }

    // Admin: list all invites
    try {
      const { member } = await requireAuth(req);
      if (!member || member.user_type !== 'administrator') {
        return res.status(403).json({ error: 'Only administrators can view invites' });
      }
    } catch (e) {
      return res.status(e.status || 401).json({ error: e.message });
    }
    const { data, error } = await supabase.from('invites').select('*').order('invited_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ invites: data });
  }

  if (req.method === 'POST') {
    let requester;
    try {
      const auth = await requireAuth(req);
      requester = auth.member;
      if (!requester || requester.user_type !== 'administrator') {
        return res.status(403).json({ error: 'Only administrators can send invites' });
      }
    } catch (e) {
      return res.status(e.status || 401).json({ error: e.message });
    }

    const allowed = await checkRateLimit(`invite_create:${requester.id}`, 20, 3600);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many invites sent recently. Please wait a while before sending more.' });
    }

    const { email, user_type, personal_note } = req.body || {};
    if (!email || !user_type) return res.status(400).json({ error: 'email and user_type are required' });

    const { data: invite, error } = await supabase
      .from('invites')
      .insert({ email, user_type, personal_note })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    const baseUrl = process.env.PUBLIC_APP_URL || 'https://radiant-booking.vercel.app';
    const inviteUrl = `${baseUrl}/?invite=${invite.token}`;

    let email_sent = false;
    try {
      await sendInvite({ to: email, userType: user_type, note: personal_note, inviteUrl });
      email_sent = true;
    } catch (e) {
      // invite record still created even if email delivery fails
    }

    return res.status(201).json({ invite, email_sent });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
