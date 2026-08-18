const { getSupabase } = require('./_lib/supabase');
const { sendInvite } = require('./_lib/email');
const { requireAuth } = require('./_lib/auth');
const { checkRateLimit } = require('./_lib/rateLimit');
const { logAudit } = require('./_lib/audit');

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

    const {
      email, emails, user_type, personal_note, is_owner, plan_tier, reserved_slots,
    } = req.body || {};
    const emailList = Array.isArray(emails) && emails.length > 0
      ? emails.map(e => e.trim()).filter(Boolean)
      : (email ? [email.trim()] : []);
    if (emailList.length === 0 || !user_type) {
      return res.status(400).json({ error: 'At least one email and user_type are required' });
    }
    if (emailList.length > 50) {
      return res.status(400).json({ error: 'Please invite up to 50 people at a time' });
    }
    const lockedTiers = ['core', 'resident'];
    // A Core/Resident member can have more than one recurring slot (e.g.
    // full day Monday + half day Friday) — reserved_slots is an array of
    // { day_of_week, time_start, time_end, room_id }.
    const slots = Array.isArray(reserved_slots) ? reserved_slots.filter(s => s && s.day_of_week && s.time_start && s.time_end) : [];
    if (plan_tier && lockedTiers.includes(plan_tier) && slots.length === 0) {
      return res.status(400).json({ error: 'Core and Resident invites need at least one agreed recurring slot' });
    }

    const allowed = await checkRateLimit(`invite_create:${requester.id}`, 20, 3600);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many invites sent recently. Please wait a while before sending more.' });
    }

    const baseUrl = process.env.PUBLIC_APP_URL || 'https://booking.radiantfr.com';
    const results = [];

    for (const oneEmail of emailList) {
      // Real bug found from actual usage: every Resend click called this
      // same endpoint with no de-duplication at all, so it just kept
      // inserting a brand new invite row (with a brand new token) every
      // time — Sent Invitations ended up with 3+ duplicate pending rows
      // for the same person. If a pending invite already exists for this
      // email, refresh and resend THAT one instead of creating another.
      const { data: existing } = await supabase
        .from('invites')
        .select('id, token')
        .eq('email', oneEmail)
        .eq('status', 'pending')
        .maybeSingle();

      let invite, error;
      if (existing) {
        ({ data: invite, error } = await supabase
          .from('invites')
          .update({
            user_type, personal_note, is_owner: !!is_owner,
            plan_tier: plan_tier || null,
            reserved_slots: lockedTiers.includes(plan_tier) ? slots : [],
            invited_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          })
          .eq('id', existing.id)
          .select()
          .single());
      } else {
        ({ data: invite, error } = await supabase
          .from('invites')
          .insert({
            email: oneEmail, user_type, personal_note, is_owner: !!is_owner,
            plan_tier: plan_tier || null,
            reserved_slots: lockedTiers.includes(plan_tier) ? slots : [],
          })
          .select()
          .single());
      }
      if (error) {
        results.push({ email: oneEmail, ok: false, error: error.message });
        continue;
      }

      logAudit({
        actorId: requester.id, actorName: `${requester.first_name} ${requester.last_name}`.trim(),
        action: existing ? 'invite.resent' : 'invite.sent', entityType: 'invite', entityId: invite.id,
        details: { email: oneEmail, user_type, is_owner: !!is_owner },
      });

      const inviteUrl = `${baseUrl}/?invite=${invite.token}`;
      let email_sent = false;
      try {
        await sendInvite({ to: oneEmail, userType: user_type, note: personal_note, inviteUrl });
        email_sent = true;
      } catch (e) {
        // invite record still created/updated even if email delivery fails
      }
      results.push({ email: oneEmail, ok: true, invite, email_sent });
    }

    if (emailList.length === 1) {
      const r = results[0];
      if (!r.ok) return res.status(500).json({ error: r.error });
      return res.status(201).json({ invite: r.invite, email_sent: r.email_sent });
    }

    return res.status(201).json({ results, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
