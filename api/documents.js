const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');

module.exports = async (req, res) => {
  try {
    const { member } = await requireAuth(req);
    if (!member) return res.status(404).json({ error: 'No member record linked to this account' });
    const supabase = getSupabase();

    if (req.method === 'GET') {
      let targetMember = member;
      if (req.query.member_id && req.query.member_id !== member.id) {
        if (member.user_type !== 'administrator') {
          return res.status(403).json({ error: 'Only Staff & Admin can view another member\'s documents' });
        }
        const { data: target, error: targetErr } = await supabase.from('members').select('id, user_type').eq('id', req.query.member_id).maybeSingle();
        if (targetErr || !target) return res.status(404).json({ error: 'Member not found' });
        targetMember = target;
      }

      const { data: docs, error } = await supabase
        .from('documents')
        .select('*')
        .eq('is_active', true)
        .contains('required_for', [targetMember.user_type])
        .order('category');
      if (error) return res.status(500).json({ error: error.message });

      const { data: sigs, error: sigErr } = await supabase
        .from('document_signatures')
        .select('document_id, version_signed, status, signed_at, signature_name')
        .eq('member_id', targetMember.id);
      if (sigErr) return res.status(500).json({ error: sigErr.message });

      const withStatus = docs.map(d => {
        const sig = sigs.find(s => s.document_id === d.id && s.version_signed === d.version && s.status === 'signed');
        return { ...d, signed: !!sig, signed_at: sig ? sig.signed_at : null, signature_name: sig ? sig.signature_name : null };
      });

      return res.status(200).json({ documents: withStatus });
    }

    if (req.method === 'POST') {
      const { document_id, signature_name } = req.body || {};
      if (!document_id) return res.status(400).json({ error: 'document_id is required' });
      if (!signature_name || signature_name.trim().length < 2) {
        return res.status(400).json({ error: 'A typed signature name is required' });
      }

      const { data: doc, error: docErr } = await supabase.from('documents').select('*').eq('id', document_id).single();
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

      return res.status(200).json({ signature: sig, onboarding_status });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
