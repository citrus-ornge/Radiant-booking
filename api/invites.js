const { getSupabase } = require('./_lib/supabase');
const { sendInvite } = require('./_lib/email');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('invites').select('*').order('invited_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ invites: data });
  }

  if (req.method === 'POST') {
    const { email, user_type, personal_note } = req.body || {};
    if (!email || !user_type) return res.status(400).json({ error: 'email and user_type are required' });

    const { data: invite, error } = await supabase
      .from('invites')
      .insert({ email, user_type, personal_note })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    const baseUrl = process.env.PUBLIC_APP_URL || 'https://radiant-booking.vercel.app';
    const inviteUrl = `${baseUrl}/invite/${invite.token}`;

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
