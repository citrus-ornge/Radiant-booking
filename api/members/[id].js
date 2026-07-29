const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');

const ALLOWED_FIELDS = [
  'first_name', 'last_name', 'phone', 'qualifications', 'specialties',
  'indemnity_number', 'indemnity_expiry', 'dbs_status', 'dbs_expiry', 'plan_tier',
];

module.exports = async (req, res) => {
  const { id } = req.query;
  try {
    const { member } = await requireAuth(req);
    if (!member) return res.status(404).json({ error: 'No member record linked to this account' });
    if (member.id !== id) return res.status(403).json({ error: 'You can only update your own profile' });

    if (req.method === 'GET') return res.status(200).json({ member });

    if (req.method === 'PATCH') {
      const updates = {};
      for (const key of ALLOWED_FIELDS) {
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) updates[key] = req.body[key];
      }
      if (member.onboarding_status === 'not_started' && (updates.first_name || updates.last_name)) {
        updates.onboarding_status = 'documents_pending';
      }
      const supabase = getSupabase();
      const { data, error } = await supabase.from('members').update(updates).eq('id', id).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ member: data });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
