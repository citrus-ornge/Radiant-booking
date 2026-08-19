const { requireAuth } = require('../_lib/auth');

// GET /api/billing/test-connection — admin-only, temporary diagnostic.
//
// Purpose: definitively separate "the token/environment is wrong" from
// "the token is valid but write permissions are restricted" — something
// no amount of re-checking Vercel's Environment Variables screen can prove
// on its own, since only the scope is visible there, never the actual
// value. A simple READ call (list customers, limit 1) needs the exact
// same valid token and live/sandbox environment setting as creating a
// Billing Request does, but none of the write-specific permissions that
// might be separately restricted. If this succeeds, the token and
// environment are proven correct beyond any doubt, and the "Forbidden"
// error on mandate creation is conclusively a write-permission issue, not
// a configuration mistake. If this also fails, that's new, different
// information worth knowing.
//
// Creates nothing, modifies nothing, reads at most 1 record. Safe to
// delete once this question is settled either way.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }
  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Only Staff & Admin can do this' });
  }

  let client;
  try {
    const gc = require('../_lib/gocardless');
    client = gc.getGoCardlessClient();
  } catch (e) {
    return res.status(503).json({ ok: false, stage: 'client_init', error: e.message });
  }

  try {
    const result = await client.customers.list({ limit: 1 });
    return res.status(200).json({
      ok: true,
      message: 'Read-only connection succeeded — token and environment are confirmed correct. Any "Forbidden" error on mandate creation specifically is a write-permission issue on the GoCardless account, not a configuration mistake.',
      customer_count_returned: (result.customers || []).length,
    });
  } catch (e) {
    const detail = (e.errors && e.errors.length)
      ? e.errors.map(x => [x.field, x.message || x.reason].filter(Boolean).join(': ')).join('; ')
      : e.message;
    return res.status(200).json({
      ok: false,
      stage: 'customers.list',
      error: detail,
      request_id: e.request_id || null,
      raw_errors: e.errors || null,
    });
  }
};
