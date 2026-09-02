const { getSupabase } = require('./_lib/supabase');
const { sendInvite } = require('./_lib/email');
const { requireAuth } = require('./_lib/auth');
const { checkRateLimit } = require('./_lib/rateLimit');
const { logAudit } = require('./_lib/audit');
const { validateSessionBlock } = require('./_lib/sessionBlocks');
const { calculateFeeBreakdown } = require('./_lib/gocardless');

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
      email, emails, user_type, personal_note, is_owner, plan_tier, reserved_slots, custom_monthly_fee_pence,
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
    // Rosie confirmed directly: Half day is fixed at 8am-1pm or 1pm-6pm,
    // Full day is fixed at 8am-6pm — no other start times or lengths are
    // valid. Same check as api/recurring-slots.js and
    // api/members-create.js — the client UI only offers these three
    // exact blocks now, but this endpoint had nothing stopping a direct
    // API call bypassing that.
    for (const s of slots) {
      const blockError = validateSessionBlock(s.time_start, s.time_end);
      if (blockError) {
        return res.status(400).json({ error: `Core and Resident recurring slots ${blockError} — ${s.day_of_week} affected` });
      }
      // Team review 26 Aug 2026: slots can recur every N weeks (weekly=1,
      // fortnightly=2, every 3rd week=3, etc.) — same validation as
      // api/recurring-slots.js.
      s.interval_weeks = s.interval_weeks != null ? parseInt(s.interval_weeks, 10) : 1;
      if (!Number.isInteger(s.interval_weeks) || s.interval_weeks < 1 || s.interval_weeks > 12) {
        return res.status(400).json({ error: `interval_weeks for ${s.day_of_week} must be a whole number between 1 and 12` });
      }
      if (s.interval_weeks > 1) {
        if (!s.anchor_date) {
          return res.status(400).json({ error: `anchor_date (the first occurrence) is required for the ${s.day_of_week} slot, which repeats every ${s.interval_weeks} weeks` });
        }
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const anchorDayName = dayNames[new Date(s.anchor_date + 'T00:00:00Z').getUTCDay()];
        if (anchorDayName !== s.day_of_week) {
          return res.status(400).json({ error: `anchor_date (${s.anchor_date}) for the ${s.day_of_week} slot falls on a ${anchorDayName} — pick the actual first ${s.day_of_week} it starts from` });
        }
      } else {
        s.anchor_date = null;
      }
    }

    // Special-deal monthly fee override (team review 19 Aug 2026) — only
    // meaningful for Core/Resident, who are the only tiers with a monthly
    // membership fee at all. Silently ignored for other tiers rather than
    // erroring, since the UI simply shouldn't show this field for them.
    let monthlyFeeOverride = null;
    if (custom_monthly_fee_pence != null && lockedTiers.includes(plan_tier)) {
      const parsed = Math.round(Number(custom_monthly_fee_pence));
      if (Number.isNaN(parsed) || parsed < 0) {
        return res.status(400).json({ error: 'custom_monthly_fee_pence must be a non-negative number' });
      }
      monthlyFeeOverride = parsed;
    }

    const allowed = await checkRateLimit(`invite_create:${requester.id}`, 20, 3600);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many invites sent recently. Please wait a while before sending more.' });
    }

    const baseUrl = process.env.PUBLIC_APP_URL || 'https://booking.radiantfr.com';
    const results = [];

    for (const oneEmail of emailList) {
      // Real bug found from actual usage: nothing checked whether this
      // email already belongs to an active member before creating a new
      // invite — only whether a PENDING invite existed (see the dedup
      // check just below, for the Resend case). Re-inviting someone
      // already accepted (weeks-old test accounts, but also spotted
      // happening to a real production email during tonight's testing)
      // created a confusing stray "pending" row sitting alongside their
      // already-"accepted" one — Dashboard's Pending Invites count and
      // the Sent Invitations list both show the same person twice, once
      // as if they'd never joined. members.email has a UNIQUE constraint,
      // so this could never actually create a second member row if that
      // stray invite were accepted — it would just fail with a raw
      // database error instead of a clear message. Caught here instead.
      const { data: existingMember } = await supabase
        .from('members')
        .select('id')
        .eq('email', oneEmail)
        .maybeSingle();
      if (existingMember) {
        results.push({ email: oneEmail, ok: false, error: 'This email already has an active account — edit their details under Members instead of re-inviting them.' });
        continue;
      }

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
        // Resend must never silently wipe a tier/reserved-slot/fee-override
        // that was already set on the pending invite. resendInvite() in
        // index.html only ever sends { email, user_type } — a deliberately
        // minimal payload for "just resend the same thing" — but this
        // update used to treat every OMITTED field as an explicit clear
        // (plan_tier || null, reserved_slots defaulting to [], the fee
        // override defaulting to null), wiping a Core/Resident invite's
        // recurring slot and fee override the moment someone clicked
        // Resend before it was accepted. Fixed by only overwriting a field
        // when its key was actually present in the request body — checked
        // via `!== undefined` against req.body directly (not the parsed
        // `plan_tier`/`reserved_slots` locals above, which default to
        // falsy/[] regardless of whether the key was sent at all) — and
        // falling back to the existing row's stored value otherwise.
        const body = req.body || {};
        const { data: fullExisting, error: fetchErr } = await supabase
          .from('invites')
          .select('plan_tier, reserved_slots, custom_monthly_fee_pence')
          .eq('id', existing.id)
          .single();
        if (fetchErr) { results.push({ email: oneEmail, ok: false, error: fetchErr.message }); continue; }

        const resolvedPlanTier = body.plan_tier !== undefined ? (plan_tier || null) : fullExisting.plan_tier;
        const resolvedSlots = body.reserved_slots !== undefined
          ? (lockedTiers.includes(resolvedPlanTier) ? slots : [])
          : fullExisting.reserved_slots;
        const resolvedFee = body.custom_monthly_fee_pence !== undefined ? monthlyFeeOverride : fullExisting.custom_monthly_fee_pence;

        ({ data: invite, error } = await supabase
          .from('invites')
          .update({
            user_type, personal_note, is_owner: !!is_owner,
            plan_tier: resolvedPlanTier,
            reserved_slots: resolvedSlots,
            custom_monthly_fee_pence: resolvedFee,
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
            custom_monthly_fee_pence: monthlyFeeOverride,
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
        // Team review: "especially the email invite... which they click
        // to accept the offer" — reserved_slots only stores room_id, so
        // the room's pricing_category needs fetching before the real
        // breakdown can be computed (custom_monthly_fee_pence is a fixed
        // negotiated figure, not derived from the rate card, so there's
        // no working to show for it).
        let feeBreakdown = null;
        if (['core', 'resident'].includes(invite.plan_tier) && invite.custom_monthly_fee_pence == null && Array.isArray(invite.reserved_slots) && invite.reserved_slots.length > 0) {
          const roomIds = [...new Set(invite.reserved_slots.map(s => s.room_id).filter(Boolean))];
          const { data: rooms } = await supabase.from('rooms').select('id, name, pricing_category').in('id', roomIds);
          const roomById = new Map((rooms || []).map(r => [r.id, r]));
          const slotsWithRoomInfo = invite.reserved_slots.map(s => ({
            ...s,
            room_name: roomById.get(s.room_id) ? roomById.get(s.room_id).name : null,
            pricing_category: roomById.get(s.room_id) ? roomById.get(s.room_id).pricing_category : null,
          }));
          feeBreakdown = calculateFeeBreakdown(invite.plan_tier, slotsWithRoomInfo);
        }
        await sendInvite({ to: oneEmail, userType: user_type, note: personal_note, inviteUrl, feeBreakdown });
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
