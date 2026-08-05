const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');

const ADMIN_EDITABLE_FIELDS = [
  'first_name', 'last_name', 'phone', 'qualifications', 'specialties',
  'indemnity_number', 'indemnity_expiry', 'dbs_status', 'dbs_expiry',
  'plan_tier', 'onboarding_status', 'user_type', 'status', 'is_owner',
  'directory_tier', 'bio', 'website_url', 'logo_url', 'social_links',
  'reserved_day_of_week', 'reserved_time_start', 'reserved_time_end', 'reserved_room_id',
];

const SELF_EDITABLE_FIELDS = [
  'first_name', 'last_name', 'phone', 'qualifications', 'specialties',
  'indemnity_number', 'indemnity_expiry', 'dbs_status', 'dbs_expiry', 'plan_tier',
  'bio', 'website_url', 'logo_url', 'social_links',
];

module.exports = async (req, res) => {
  const supabase = getSupabase();

  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  if (req.method === 'GET') {
    if (req.query.directory === 'true') {
      // Public-within-the-app directory: safe fields only, visible to any
      // signed-in user. Includes both community Members and Practitioners -
      // every room membership tier includes a directory listing benefit.
      const { data, error } = await supabase
        .from('members')
        .select('id, first_name, last_name, user_type, bio, website_url, logo_url, social_links, directory_tier, plan_tier, qualifications, status')
        .in('user_type', ['member', 'practitioner'])
        .eq('status', 'active')
        .order('first_name');
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ members: data });
    }

    if (requester.user_type === 'administrator') {
      const { data, error } = await supabase
        .from('members')
        .select('id, first_name, last_name, email, phone, user_type, status, google_calendar_connected, created_at, qualifications, indemnity_number, indemnity_expiry, dbs_status, dbs_expiry, plan_tier, onboarding_status, is_owner, directory_tier, bio, website_url, logo_url, social_links, reserved_day_of_week, reserved_time_start, reserved_time_end, reserved_room_id')
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ members: data });
    }

    // Non-admins get a reduced, safe field set - just enough for avatars,
    // booking displays, and the message recipient picker. No contact
    // details, no clinical/compliance data.
    const { data, error } = await supabase
      .from('members')
      .select('id, first_name, last_name, user_type, status, is_owner')
      .eq('status', 'active')
      .order('first_name');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ members: data });
  }

  if (req.method === 'POST') {
    if (requester.user_type !== 'administrator') {
      return res.status(403).json({ error: 'Only Staff & Admin can add members directly' });
    }
    const { first_name, last_name, email, phone, user_type } = req.body || {};
    if (!first_name || !last_name || !email || !user_type) {
      return res.status(400).json({ error: 'first_name, last_name, email, and user_type are required' });
    }
    const { data, error } = await supabase
      .from('members')
      .insert({ first_name, last_name, email, phone, user_type })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ member: data });
  }

  if (req.method === 'PATCH') {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const isSelf = requester.id === id;
    const isAdmin = requester.user_type === 'administrator';
    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: 'You can only update your own profile' });
    }

    const allowedFields = isAdmin ? ADMIN_EDITABLE_FIELDS : SELF_EDITABLE_FIELDS;
    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) updates[key] = fields[key];
    }

    // First time a self-service user fills in their name, nudge onboarding forward
    if (isSelf && requester.onboarding_status === 'not_started' && (updates.first_name || updates.last_name)) {
      updates.onboarding_status = 'documents_pending';
    }

    // Track when a Core/Resident membership cycle starts, so we can time the
    // exit-notice reminder off a real anchor date. Any change of tier resets
    // the cycle clock and clears any prior reminder flag for the old cycle.
    // (Fetch the target member's current tier — requester.plan_tier is the
    // acting admin's own tier, not necessarily the same as the target's.)
    if (Object.prototype.hasOwnProperty.call(updates, 'plan_tier')) {
      const { data: targetCurrent } = await supabase.from('members').select('plan_tier').eq('id', id).maybeSingle();
      if (!targetCurrent || updates.plan_tier !== targetCurrent.plan_tier) {
        updates.plan_tier_started_at = ['core', 'resident'].includes(updates.plan_tier) ? new Date().toISOString() : null;
        updates.exit_reminder_sent_for_cycle_end = null;
      }
    }

    const { data, error } = await supabase.from('members').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (isAdmin) {
      logAudit({
        actorId: requester.id, actorName: `${requester.first_name} ${requester.last_name}`.trim(),
        action: 'member.updated', entityType: 'member', entityId: id,
        details: { fields: Object.keys(updates), target_name: `${data.first_name} ${data.last_name}`.trim() },
      });
    }
    return res.status(200).json({ member: data });
  }

  if (req.method === 'DELETE') {
    if (requester.user_type !== 'administrator') {
      return res.status(403).json({ error: 'Only administrators can delete members' });
    }
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (id === requester.id) {
      return res.status(400).json({ error: 'Use the Profile page to delete your own account' });
    }

    const { data: target, error: fetchErr } = await supabase.from('members').select('auth_user_id, first_name, last_name, email').eq('id', id).single();
    if (fetchErr) return res.status(404).json({ error: 'Member not found' });

    const { error } = await supabase.from('members').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    logAudit({
      actorId: requester.id, actorName: `${requester.first_name} ${requester.last_name}`.trim(),
      action: 'member.deleted', entityType: 'member', entityId: id,
      details: { target_name: `${target.first_name} ${target.last_name}`.trim(), target_email: target.email },
    });

    if (target.auth_user_id) {
      try {
        await supabase.auth.admin.deleteUser(target.auth_user_id);
      } catch (e) {
        console.error('Failed to delete auth user for member', id, e.message);
      }
    }

    return res.status(200).json({ deleted: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
