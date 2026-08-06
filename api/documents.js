const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');

module.exports = async (req, res) => {
  try {
    const { member } = await requireAuth(req);
    if (!member) return res.status(404).json({ error: 'No member record linked to this account' });
    const supabase = getSupabase();

    if (req.method === 'GET') {
      if (req.query.all === 'true') {
        if (member.user_type !== 'administrator') {
          return res.status(403).json({ error: 'Only Staff & Admin can view all documents' });
        }
        const { data: allDocs, error: allErr } = await supabase.from('documents').select('*').order('category').order('title');
        if (allErr) return res.status(500).json({ error: allErr.message });
        return res.status(200).json({ documents: allDocs });
      }

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
          title_snapshot: doc.title, content_snapshot: doc.content,
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
      if (allSigned && !['booking_pending', 'completed'].includes(member.onboarding_status)) {
        // Core/Resident members who've been offered a recurring slot still
        // need to explicitly accept it before onboarding is actually done —
        // documents alone don't confirm the room. Everyone else (no slot
        // offered) goes straight to completed, same as before.
        const hasOfferedSlot = ['core', 'resident'].includes(member.plan_tier) && member.reserved_day_of_week && !member.room_terms_accepted_at;
        onboarding_status = hasOfferedSlot ? 'booking_pending' : 'completed';
        await supabase.from('members').update({ onboarding_status }).eq('id', member.id);
      }

      return res.status(200).json({ signature: sig, onboarding_status });
    }

    if (req.method === 'PUT') {
      // Admin: create a new document
      if (member.user_type !== 'administrator') {
        return res.status(403).json({ error: 'Only Staff & Admin can create documents' });
      }
      const { title, category, content, required_for } = req.body || {};
      if (!title || !category || !content || !Array.isArray(required_for) || required_for.length === 0) {
        return res.status(400).json({ error: 'title, category, content, and at least one required_for role are required' });
      }
      const { data, error } = await supabase
        .from('documents')
        .insert({ title, category, content, required_for, version: 1, is_active: true })
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });

      logAudit({
        actorId: member.id, actorName: `${member.first_name} ${member.last_name}`.trim(),
        action: 'document.created', entityType: 'document', entityId: data.id, details: { title },
      });

      return res.status(201).json({ document: data });
    }

    if (req.method === 'PATCH') {
      // Admin: edit a document. Changing the content bumps the version,
      // which means everyone who already signed the old version now shows
      // as needing to re-sign - correct, since what they agreed to changed.
      if (member.user_type !== 'administrator') {
        return res.status(403).json({ error: 'Only Staff & Admin can edit documents' });
      }
      const { id, title, category, content, required_for, is_active } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data: existing, error: fetchErr } = await supabase.from('documents').select('*').eq('id', id).single();
      if (fetchErr) return res.status(404).json({ error: 'Document not found' });

      const updates = {};
      if (title !== undefined) updates.title = title;
      if (category !== undefined) updates.category = category;
      if (required_for !== undefined) updates.required_for = required_for;
      if (is_active !== undefined) updates.is_active = is_active;
      if (content !== undefined && content !== existing.content) {
        updates.content = content;
        updates.version = existing.version + 1;
      }

      const { data, error } = await supabase.from('documents').update(updates).eq('id', id).select().single();
      if (error) return res.status(500).json({ error: error.message });

      logAudit({
        actorId: member.id, actorName: `${member.first_name} ${member.last_name}`.trim(),
        action: 'document.updated', entityType: 'document', entityId: id,
        details: { fields: Object.keys(updates), version_bumped: updates.version !== undefined },
      });

      return res.status(200).json({ document: data });
    }

    if (req.method === 'DELETE') {
      // Soft-delete: deactivate rather than hard-delete, so past signatures
      // remain valid historical records.
      if (member.user_type !== 'administrator') {
        return res.status(403).json({ error: 'Only Staff & Admin can remove documents' });
      }
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { error } = await supabase.from('documents').update({ is_active: false }).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });

      logAudit({
        actorId: member.id, actorName: `${member.first_name} ${member.last_name}`.trim(),
        action: 'document.deactivated', entityType: 'document', entityId: id,
      });

      return res.status(200).json({ deactivated: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
