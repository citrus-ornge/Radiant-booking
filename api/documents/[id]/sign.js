const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { id: documentId } = req.query;
  try {
    const { member } = await requireAuth(req);
    if (!member) return res.status(404).json({ error: 'No member record linked to this account' });

    const { signature_name } = req.body || {};
    if (!signature_name || signature_name.trim().length < 2) {
      return res.status(400).json({ error: 'A typed signature name is required' });
    }

    const supabase = getSupabase();
    const { data: doc, error: docErr } = await supabase.from('documents').select('*').eq('id', documentId).single();
    if (docErr) return res.status(404).json({ error: 'Document not found' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;

    const { data: sig, error } = await supabase
      .from('document_signatures')
      .upsert({
        document_id: doc.id, member_id: member.id, version_signed: doc.version,
        signature_name: signature_name.trim(), ip_address: ip, status: 'signed',
      }, { onConflict: 'document_id,member_id,version_signed' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // Check if all required docs for this member's user_type are now signed
    const { data: requiredDocs } = await supabase
      .from('documents')
      .select('id, version')
      .eq('is_active', true)
      .contains('required_for', [member.user_type]);
    const { data: allSigs } = await supabase
      .from('document_signatures')
      .select('document_id, version_signed, status')
      .eq('member_id', member.id)
      .eq('status', 'signed');

    const allSigned = requiredDocs.every(d => allSigs.some(s => s.document_id === d.id && s.version_signed === d.version));
    let onboarding_status = member.onboarding_status;
    if (allSigned && member.onboarding_status !== 'completed') {
      onboarding_status = 'completed';
      await supabase.from('members').update({ onboarding_status }).eq('id', member.id);
    }

    res.status(200).json({ signature: sig, onboarding_status });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
