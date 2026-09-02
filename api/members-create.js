const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');
const { validateSessionBlock } = require('./_lib/sessionBlocks');

// POST /api/members-create
// Admin-only "create now" path — distinct from Invite (api/invites.js),
// which sends an email and waits for the person to accept before any
// account exists. This creates a real, active, already-confirmed account
// immediately: useful for a walk-in, or anyone who's already agreed to
// join and shouldn't need to wait on an email round-trip. Kept genuinely
// separate from Invite rather than merging them — "create now" and
// "invite and wait" are different operations with different guarantees.
//
// Reuses the app's EXISTING password-recovery flow (the same one behind
// "Forgot password?") rather than inventing new set-password UI: creates
// the auth user with a random password nobody will ever use, then emails
// a genuine Supabase recovery link. When they click it, the app's existing
// PASSWORD_RECOVERY handler (already built, already tested) takes over.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();
  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }
  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Only Staff & Admin can add users directly' });
  }

  const { first_name, last_name, email, phone, user_type, plan_tier, reserved_slots, custom_monthly_fee_pence } = req.body || {};
  if (!first_name || !last_name || !email || !user_type) {
    return res.status(400).json({ error: 'first_name, last_name, email and user_type are required' });
  }
  const validTypes = ['practitioner', 'member', 'guest', 'administrator'];
  if (!validTypes.includes(user_type)) {
    return res.status(400).json({ error: 'Invalid user_type' });
  }
  const validTiers = ['community', 'flex', 'core', 'resident'];
  const tier = user_type === 'practitioner' && validTiers.includes(plan_tier) ? plan_tier : null;
  // A Core/Resident member can have more than one recurring slot (e.g. full
  // day Monday + half day Friday) — same array shape as Invite's
  // reserved_slots. Required for these tiers since a Core/Resident account
  // with no slot at all can't actually book their included session.
  const lockedTiers = ['core', 'resident'];
  const slots = Array.isArray(reserved_slots) ? reserved_slots.filter(s => s && s.day_of_week && s.time_start && s.time_end) : [];
  if (lockedTiers.includes(tier) && slots.length === 0) {
    return res.status(400).json({ error: 'Core and Resident need at least one agreed recurring slot' });
  }
  // Rosie, 23 Aug: "residents and core can only have full or half days" —
  // genuine gap found live 26 Aug: this endpoint (Add User's direct
  // member-creation path) never had this check applied at all, unlike
  // api/recurring-slots.js and api/invites.js. Closed here at the same
  // time as adding interval_weeks validation below, since a direct API
  // call to this endpoint specifically could otherwise bypass it entirely.
  for (const s of slots) {
    const blockError = validateSessionBlock(s.time_start, s.time_end);
    if (blockError) {
      return res.status(400).json({ error: `Core and Resident recurring slots ${blockError} — ${s.day_of_week} affected` });
    }
    // Team review 26 Aug 2026: slots can recur every N weeks (weekly=1,
    // fortnightly=2, every 3rd week=3, etc.) — same validation as
    // api/recurring-slots.js and api/invites.js.
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

  // Check for an existing member row first (fast, cheap). The real
  // guarantee against a duplicate account comes from createUser() itself
  // below, which enforces email uniqueness at the auth level — a separate
  // listUsers()-based pre-check would only see one page of users and could
  // silently miss a match once there are enough accounts to paginate.
  const { data: existingMember } = await supabase.from('members').select('id').eq('email', email).maybeSingle();
  if (existingMember) return res.status(409).json({ error: 'A member with this email already exists' });

  // Random password nobody will actually use — they set their own via the
  // recovery link below. Just needs to satisfy Supabase's requirements.
  const tempPassword = require('crypto').randomBytes(24).toString('base64');

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email, password: tempPassword, email_confirm: true,
  });
  if (createErr) {
    // Supabase enforces unique emails at the auth level — this is what
    // actually catches a duplicate, including one a fresh listUsers() call
    // might have missed on an earlier page.
    const isDuplicate = /already registered|already exists/i.test(createErr.message || '');
    return res.status(isDuplicate ? 409 : 500).json({ error: isDuplicate ? 'An account with this email already exists' : `Could not create login: ${createErr.message}` });
  }

  const { data: member, error: memberErr } = await supabase
    .from('members')
    .insert({
      auth_user_id: created.user.id, first_name, last_name, email, phone: phone || null,
      user_type, status: 'active',
      // First/last name already provided by admin — same as the existing
      // onboarding logic that skips straight to documents when a name is
      // already on file, rather than asking the person to re-enter it.
      onboarding_status: 'documents_pending',
      plan_tier: tier,
      plan_tier_started_at: ['core', 'resident'].includes(tier) ? new Date().toISOString() : null,
      custom_monthly_fee_pence: ['core', 'resident'].includes(tier) && custom_monthly_fee_pence != null ? custom_monthly_fee_pence : null,
    })
    .select()
    .single();
  if (memberErr) {
    // Roll back the auth user rather than leave an orphaned login with no
    // member record — the reverse of the exact bug this endpoint guards
    // against on the way in.
    await supabase.auth.admin.deleteUser(created.user.id);
    return res.status(500).json({ error: memberErr.message });
  }

  if (slots.length > 0) {
    await supabase.from('member_recurring_slots').insert(
      slots.map(s => ({ member_id: member.id, day_of_week: s.day_of_week, time_start: s.time_start, time_end: s.time_end, room_id: s.room_id || null, interval_weeks: s.interval_weeks || 1, anchor_date: s.anchor_date || null }))
    );
  }

  const baseUrl = process.env.PUBLIC_APP_URL || 'https://booking.radiantfr.com';
  let email_sent = false;
  try {
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'recovery', email, options: { redirectTo: baseUrl },
    });
    if (linkErr) throw linkErr;
    const { sendAccountCreatedEmail } = require('./_lib/email');
    // Same real fee breakdown as invites.js — reserved_slots only stores
    // room_id, so pricing_category needs fetching first. custom_monthly_
    // fee_pence is a fixed negotiated figure, not derived from the rate
    // card, so there's no working to show for it.
    let feeBreakdown = null;
    if (['core', 'resident'].includes(tier) && custom_monthly_fee_pence == null && slots.length > 0) {
      const { calculateFeeBreakdown } = require('./_lib/gocardless');
      const roomIds = [...new Set(slots.map(s => s.room_id).filter(Boolean))];
      const { data: rooms } = await supabase.from('rooms').select('id, name, pricing_category').in('id', roomIds);
      const roomById = new Map((rooms || []).map(r => [r.id, r]));
      const slotsWithRoomInfo = slots.map(s => ({
        ...s,
        room_name: roomById.get(s.room_id) ? roomById.get(s.room_id).name : null,
        pricing_category: roomById.get(s.room_id) ? roomById.get(s.room_id).pricing_category : null,
      }));
      feeBreakdown = calculateFeeBreakdown(tier, slotsWithRoomInfo);
    }
    await sendAccountCreatedEmail({
      to: email, firstName: first_name,
      actionLink: linkData.properties.action_link,
      feeBreakdown,
    });
    email_sent = true;
  } catch (e) {
    console.error(`Account created for ${email} but welcome email failed:`, e.message);
    // Don't fail the request — the account is real and usable via
    // "Forgot password?" even if this particular email didn't go out.
  }

  await logAudit({
    actorId: requester.id,
    actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
    action: 'member.created_directly',
    entityType: 'member', entityId: member.id,
    details: { email, user_type, plan_tier: tier },
  });

  return res.status(201).json({ member, email_sent });
};
