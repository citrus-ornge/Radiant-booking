const crypto = require('crypto');
const { getSupabase } = require('../_lib/supabase');
const { logAudit } = require('../_lib/audit');
const { readRawBody } = require('../_lib/gocardless');

// Vercel parses JSON bodies by default, which would give us a re-serialized
// copy rather than the exact bytes GoCardless signed — verification needs the
// raw body, so parsing is disabled here and read manually below.
module.exports.config = { api: { bodyParser: false } };

// POST /api/webhooks/gocardless
// Receives Direct Debit lifecycle events (mandate active/failed/cancelled,
// payment confirmed/failed, etc). Configure this URL in the GoCardless
// dashboard under Developers > Webhook endpoints, and set GC_WEBHOOK_SECRET
// to the secret shown there.
//
// GoCardless requires a 200 response within a few seconds and will retry on
// failure/timeout, so this handler does the minimum synchronous work (verify
// signature, update DB) and nothing that could be slow (no emails here yet —
// add via a queue/cron if that's needed later, don't block the webhook on it).
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.GC_WEBHOOK_SECRET;
  if (!secret) {
    console.error('GC_WEBHOOK_SECRET is not set — cannot verify GoCardless webhooks.');
    return res.status(503).end();
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['webhook-signature'];
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  // Constant-time comparison to avoid a timing side-channel; lengths must
  // match first or timingSafeEqual throws.
  const isValid = typeof signature === 'string'
    && signature.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

  if (!isValid) {
    console.error('Invalid GoCardless webhook signature');
    return res.status(498).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const events = payload.events || [];
  const supabase = getSupabase();

  // Respond 200 as soon as verification + parsing succeeds, then process.
  // GoCardless only needs the ack; if a per-event update fails it's logged
  // for follow-up rather than turning into a retry storm.
  res.status(200).json({ received: true });

  for (const event of events) {
    try {
      await handleEvent(supabase, event);
    } catch (e) {
      console.error(`Failed to process GoCardless event ${event.id} (${event.resource_type}.${event.action}):`, e.message);
    }
  }
};

async function handleEvent(supabase, event) {
  const { resource_type, action, links = {} } = event;

  if (resource_type === 'mandates') {
    // active | cancelled | failed | expired | ... — see GoCardless mandate
    // event actions. We only special-case the ones that change what a
    // member can do; anything else (e.g. 'transferred') is logged, not acted on.
    const statusMap = { active: 'active', cancelled: 'cancelled', failed: 'failed', expired: 'expired' };
    const mandateStatus = statusMap[action];
    if (!mandateStatus || !links.customer) return;

    const updates = { mandate_status: mandateStatus };
    if (mandateStatus === 'active' && links.mandate) updates.gocardless_mandate_id = links.mandate;

    const { data: member, error } = await supabase
      .from('members')
      .update(updates)
      .eq('gocardless_customer_id', links.customer)
      .select('id, first_name, last_name')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!member) {
      console.error(`GoCardless mandate event for unknown customer ${links.customer}`);
      return;
    }

    await logAudit({
      actorId: null,
      actorName: 'GoCardless webhook',
      action: `billing.mandate_${mandateStatus}`,
      entityType: 'member',
      entityId: member.id,
      details: { event_id: event.id },
    });
    return;
  }

  // Payment-status updates are intentionally not wired up yet — bookings
  // don't currently carry a gocardless_payment_id to join against, and the
  // per-session pricing (vs a flat monthly subscription) needs a decision on
  // how/when payments are actually created before this can update the right
  // row. TODO once that's designed: handle resource_type === 'payments'
  // (confirmed/failed/cancelled) and update the matching booking's
  // payment_status.
}
