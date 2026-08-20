const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const PDFKit = require('pdfkit');

// GET /api/documents/pdf?document_id=X[&member_id=Y]
//
// Generates a PDF on the fly from a SIGNED document's content_snapshot —
// the resolved, personalised text the member actually agreed to (real
// name/tier/business details filled in), not the raw template. This is
// distinct from documents.pdf_path (a static file, same for everyone),
// which only works for documents with no per-member templating at all.
// The Practitioner Membership Agreement is the first document that needed
// this: its text differs per signer, so a single shared static PDF
// wouldn't correctly represent what any specific person actually signed.
//
// Self-serve by default (member_id defaults to the caller); an admin can
// pass member_id to download on behalf of someone else, same pattern as
// GET /api/documents.
const GOLD = '#B8935A';
const DARK = '#1A1A1A';
const GREY = '#777777';

function renderMarkdownToPdf(doc, content, leftMargin) {
  const lines = (content || '').split('\n');
  for (const line of lines) {
    if (line.trim() === '') { doc.moveDown(0.4); continue; }

    if (line.startsWith('## ')) {
      doc.moveDown(0.6).font('Helvetica-Bold').fontSize(13).fillColor(DARK).text(line.slice(3).trim(), leftMargin, undefined);
      doc.moveDown(0.2);
      continue;
    }

    if (line.startsWith('- ')) {
      doc.font('Helvetica').fontSize(10.5).fillColor(DARK);
      renderInlineBold(doc, '•  ' + line.slice(2).trim(), leftMargin + 14);
      continue;
    }

    // Plain paragraph — may contain **bold** runs.
    doc.font('Helvetica').fontSize(10.5).fillColor(DARK);
    renderInlineBold(doc, line.trim(), leftMargin);
  }
}

// pdfkit doesn't parse markdown itself — this splits a line on **bold**
// markers and toggles the font per run, using continued text so runs sit
// on the same visual line rather than each starting a new one. Bug found
// while testing: pdfkit's cursor (doc.x) doesn't reset to the page margin
// between calls the way you'd expect — relying on doc.x as the base for
// each new line's indent caused indentation to cascade further right with
// every single line (bullets, then headings, drifting off the page by
// the end). Fixed by always passing an explicit left-margin x rather than
// ever reading doc.x back.
function renderInlineBold(doc, line, x) {
  const parts = line.split('**');
  let first = true;
  parts.forEach((part, idx) => {
    if (part === '') return;
    const bold = idx % 2 === 1;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(part, first ? x : undefined, undefined, { continued: idx < parts.length - 1 });
    first = false;
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();
  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  const documentId = req.query.document_id;
  if (!documentId) return res.status(400).json({ error: 'document_id is required' });

  let targetMemberId = requester.id;
  if (req.query.member_id && req.query.member_id !== requester.id) {
    if (requester.user_type !== 'administrator') {
      return res.status(403).json({ error: 'Only Staff & Admin can download another member\'s signed document' });
    }
    targetMemberId = req.query.member_id;
  }

  const { data: sig, error } = await supabase
    .from('document_signatures')
    .select('title_snapshot, content_snapshot, signature_name, signed_at, ip_address')
    .eq('document_id', documentId)
    .eq('member_id', targetMemberId)
    .eq('status', 'signed')
    .order('signed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!sig) return res.status(404).json({ error: 'No signed copy of this document found for this member' });

  const filename = `${sig.title_snapshot.replace(/[^a-z0-9]+/gi, '-')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFKit({ size: 'A4', margins: { top: 60, bottom: 60, left: 60, right: 60 } });
  doc.pipe(res);
  const LEFT = doc.page.margins.left;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(GOLD).text('RADIANT', LEFT, undefined, { characterSpacing: 1 });
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text('MEDICAL AESTHETICS & WELLNESS', LEFT, undefined, { characterSpacing: 0.5 });
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(17).fillColor(DARK).text(sig.title_snapshot, LEFT, undefined);
  doc.moveDown(0.8);

  renderMarkdownToPdf(doc, sig.content_snapshot, LEFT);

  doc.moveDown(1.2);
  doc.strokeColor('#E8E4DC').moveTo(LEFT, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK).text('Signed electronically', LEFT, undefined);
  doc.font('Helvetica').fontSize(9).fillColor(GREY);
  doc.text(`Name typed at signing: ${sig.signature_name}`, LEFT, undefined);
  doc.text(`Signed: ${new Date(sig.signed_at).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}`, LEFT, undefined);
  if (sig.ip_address) doc.text(`IP address recorded: ${sig.ip_address}`, LEFT, undefined);

  doc.end();
};
