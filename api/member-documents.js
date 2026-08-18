const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');
const crypto = require('crypto');

const BUCKET = 'member-documents';
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8MB — Vercel serverless functions have a real body-size ceiling (~4.5MB raw), and base64 encoding adds ~33% overhead on top of that, so this is a practical, honest limit rather than an arbitrary one. A clear error beats a cryptic failure on anything bigger (e.g. a very high-res phone photo).

// GET    /api/member-documents?member_id=X              — list a member's own uploaded compliance documents
// GET    /api/member-documents?id=X&action=download      — a short-lived signed URL to view/download one file
// POST   /api/member-documents { member_id, document_type, file_name, file_base64, notes, expiry_date }
// DELETE /api/member-documents?id=X
//
// Distinct from api/documents.js, which is the clinic's own policies that
// a practitioner SIGNS. This is the reverse direction: a practitioner's own
// files (proof of ID, insurance/indemnity certificate, qualification
// certificates) that the clinic keeps on record. Stored in a private
// Supabase Storage bucket, scoped per member (member-documents/{member_id}/
// {uuid}-{filename}) — every read/write goes through this endpoint using
// the service role key, same access-control pattern as the rest of the app.
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
  const isAdmin = requester.user_type === 'administrator';

  if (req.method === 'GET' && req.query.action === 'download') {
    const { data: doc, error } = await supabase.from('member_documents').select('member_id, storage_path, file_name').eq('id', req.query.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.member_id !== requester.id && !isAdmin) return res.status(403).json({ error: 'Not authorised to view this document' });

    const { data: signed, error: signErr } = await supabase.storage.from(BUCKET).createSignedUrl(doc.storage_path, 300, { download: doc.file_name }); // 5 minutes — short-lived is fine, the app re-requests a fresh link each time someone clicks
    if (signErr) return res.status(500).json({ error: signErr.message });
    return res.status(200).json({ url: signed.signedUrl });
  }

  if (req.method === 'GET') {
    const memberId = req.query.member_id;
    if (!memberId) return res.status(400).json({ error: 'member_id is required' });
    if (memberId !== requester.id && !isAdmin) return res.status(403).json({ error: 'You can only view your own documents' });

    const { data, error } = await supabase
      .from('member_documents')
      .select('id, document_type, file_name, file_size_bytes, notes, expiry_date, uploaded_at')
      .eq('member_id', memberId)
      .order('uploaded_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ documents: data });
  }

  if (req.method === 'POST') {
    const { member_id, document_type, file_name, file_base64, notes, expiry_date } = req.body || {};
    if (!member_id || !document_type || !file_name || !file_base64) {
      return res.status(400).json({ error: 'member_id, document_type, file_name and file_base64 are required' });
    }
    if (member_id !== requester.id && !isAdmin) {
      return res.status(403).json({ error: 'You can only upload documents to your own account' });
    }
    if (!['id_proof', 'insurance', 'qualification', 'other'].includes(document_type)) {
      return res.status(400).json({ error: 'Invalid document_type' });
    }

    const buffer = Buffer.from(file_base64, 'base64');
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      return res.status(413).json({ error: `File is too large (max ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB). Try a smaller scan or photo.` });
    }

    const safeFileName = file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${member_id}/${crypto.randomUUID()}-${safeFileName}`;

    const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, { contentType: guessContentType(safeFileName) });
    if (uploadErr) return res.status(500).json({ error: `Upload failed: ${uploadErr.message}` });

    const { data: doc, error: dbErr } = await supabase
      .from('member_documents')
      .insert({
        member_id, document_type, file_name, storage_path: storagePath,
        file_size_bytes: buffer.length, notes: notes || null, expiry_date: expiry_date || null,
        uploaded_by: requester.id,
      })
      .select('id, document_type, file_name, file_size_bytes, notes, expiry_date, uploaded_at')
      .single();
    if (dbErr) {
      // Don't leave an orphaned file in storage if the metadata row fails
      await supabase.storage.from(BUCKET).remove([storagePath]);
      return res.status(500).json({ error: dbErr.message });
    }

    await logAudit({
      actorId: requester.id,
      actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
      action: 'member_document.uploaded',
      entityType: 'member',
      entityId: member_id,
      details: { document_type, file_name },
    });

    return res.status(201).json({ document: doc });
  }

  if (req.method === 'DELETE') {
    const { data: doc, error: findErr } = await supabase.from('member_documents').select('member_id, storage_path, document_type, file_name').eq('id', req.query.id).maybeSingle();
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.member_id !== requester.id && !isAdmin) return res.status(403).json({ error: 'Not authorised to delete this document' });

    await supabase.storage.from(BUCKET).remove([doc.storage_path]);
    const { error: delErr } = await supabase.from('member_documents').delete().eq('id', req.query.id);
    if (delErr) return res.status(500).json({ error: delErr.message });

    await logAudit({
      actorId: requester.id,
      actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
      action: 'member_document.deleted',
      entityType: 'member',
      entityId: doc.member_id,
      details: { document_type: doc.document_type, file_name: doc.file_name },
    });

    return res.status(200).json({ deleted: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

function guessContentType(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  return { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp' }[ext] || 'application/octet-stream';
}
