const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');

const ADMIN_EDITABLE_FIELDS = [
  'first_name', 'last_name', 'phone', 'qualifications', 'specialties',
  'indemnity_number', 'indemnity_expiry', 'dbs_status', 'dbs_expiry',
  'plan_tier', 'onboarding_status', 'user_type', 'status',
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
      if (!requester || requester.user_type !== 'administrator') {
        return res.status(403).json({ error: 'Only administrators can edit other members' });
      }
      const { id, ...fields } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const updates = {};
      for (const key of ADMIN_EDITABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) updates[key] = fields[key];
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
