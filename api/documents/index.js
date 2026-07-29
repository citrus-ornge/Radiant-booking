const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { member } = await requireAuth(req);
    if (!member) return res.status(404).json({ error: 'No member record linked to this account' });

    const supabase = getSupabase();
    const { data: docs, error } = await supabase
      .from('documents')
      .select('*')
      .eq('is_active', true)
      .contains('required_for', [member.user_type])
      .order('category');
    if (error) return res.status(500).json({ error: error.message });

    const { data: sigs, error: sigErr } = await supabase
      .from('document_signatures')
      .select('document_id, version_signed, status, signed_at')
      .eq('member_id', member.id);
    if (sigErr) return res.status(500).json({ error: sigErr.message });

    const withStatus = docs.map(d => {
      const sig = sigs.find(s => s.document_id === d.id && s.version_signed === d.version && s.status === 'signed');
      return { ...d, signed: !!sig, signed_at: sig ? sig.signed_at : null };
    });

    res.status(200).json({ documents: withStatus });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
