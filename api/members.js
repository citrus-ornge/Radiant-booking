const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');

const ADMIN_EDITABLE_FIELDS = [
  'first_name', 'last_name', 'phone', 'qualifications', 'specialties',
  'indemnity_number', 'indemnity_expiry', 'dbs_status', 'dbs_expiry',
  'plan_tier', 'onboarding_status', 'user_type', 'status',
];

const SELF_EDITABLE_FIELDS = [
  'first_name', 'last_name', 'phone', 'qualifications', 'specialties',
  'indemnity_number', 'indemnity_expiry', 'dbs_status', 'dbs_expiry', 'plan_tier',
];

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('members')
      .select('id, first_name, last_name, email, phone, user_type, status, google_calendar_connected, created_at, qualifications, indemnity_number, indemnity_expiry, dbs_status, dbs_expiry, plan_tier, onboarding_status')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ members: data });
  }

  if (req.method === 'POST') {
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
    try {
      const { member: requester } = await requireAuth(req);
      if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });

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

      const { data, error } = await supabase.from('members').update(updates).eq('id', id).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ member: data });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
