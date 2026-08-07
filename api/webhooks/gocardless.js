const crypto = require('crypto');
const { getSupabase } = require('../_lib/supabase');
const { logAudit } = require('../_lib/audit');
// _lib/gocardless required lazily inside the handler — see mandate.js.

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

  let readRawBody;
  try {
    ({ readRawBody } = require('../_lib/gocardless'));
  } catch (e) {
    console.error('Failed to load _lib/gocardless in webhook handler:', e.message);
    return res.status(503).end();
  }

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
    // Temporary: log every event's shape in full. We've hit two real bugs
    // already this session where the actual field names/values GoCardless
    // sends didn't match assumptions from documentation, and Vercel logs
    // don't capture request bodies by default — this is the only way to
    // see the real payload without guessing again. Remove once the
    // fulfilled/payment matching is confirmed working end-to-end.
    console.log(`GC webhook event: ${event.resource_type}.${event.action}`, JSON.stringify(event.links || {}));
    try {
      await handleEvent(supabase, event);
    } catch (e) {
      console.error(`Failed to process GoCardless event ${event.id} (${event.resource_type}.${event.action}):`, e.message);
    }
  }
};

async function handleEvent(supabase, event) {
  const { resource_type, action, links = {} } = event;

  // Instant Bank Pay: once the Billing Request is fulfilled, the payment it
  // created is in links.payment_request_payment. Link it to the booking we
  // stashed the billing_request id against — the actual paid/failed status
  // still comes from the 'payments' handling below once GoCardless confirms it.
  if (resource_type === 'billing_requests' && action === 'fulfilled' && links.payment_request_payment) {
    const { data: booking, error } = await supabase
      .from('bookings')
      .update({ gocardless_payment_id: links.payment_request_payment })
      .eq('gocardless_billing_request_id', links.billing_request)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (booking) {
      await logAudit({
        actorId: null,
        actorName: 'GoCardless webhook',
        action: 'billing.instant_pay_fulfilled',
        entityType: 'booking',
        entityId: booking.id,
        details: { event_id: event.id, payment_id: links.payment_request_payment },
      });
    }
    // Don't return — a billing_requests event can't also be a mandates/payments
    // event, so falling through just hits the no-op default below.
  }

  if (resource_type === 'mandates') {
    // Maps GoCardless's mandate event actions to the exact vocabulary the
    // members.mandate_status CHECK constraint allows (which mirrors
    // GoCardless's own mandate.status field). Reflecting the intermediate
    // states (not just active/cancelled/failed/expired) matters here so the
    // UI can show something more honest than 'Not set up yet' while a
    // mandate is genuinely in progress — BACS submissions take ~1 business
    // day even in sandbox, so members will sit in one of these states for a
    // real stretch of time, not just a few seconds.
    const statusMap = {
      created: 'pending_customer_approval',
      customer_approval_granted: 'pending_submission',
      customer_approval_skipped: 'pending_submission',
      submitted: 'submitted',
      active: 'active',
      cancelled: 'cancelled',
      failed: 'failed',
      expired: 'expired',
    };
    const mandateStatus = statusMap[action];
    if (!mandateStatus || !links.customer) return;

    const updates = { mandate_status: mandateStatus };
    if (mandateStatus === 'active' && links.mandate) updates.gocardless_mandate_id = links.mandate;

    const { data: member, error } = await supabase
      .from('members')
      .update(updates)
      .eq('gocardless_customer_id', links.customer)
      .select('id, first_name, last_name, plan_tier, gocardless_subscription_id, gocardless_mandate_id')
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

    // Core/Resident have a flat monthly membership fee on top of any
    // per-session charges (confirmed by Radiant) — set up the recurring
    // subscription the moment their mandate goes active, but only once
    // (guarded by gocardless_subscription_id) so this never double-bills on
    // a retried or duplicate webhook delivery.
    // NOTE: PLAN_TIER_MONTHLY_PENCE amounts are still placeholders pending
    // confirmation against the brochure (see api/_lib/gocardless.js) — do
    // not go live on real payment collection until those are confirmed.
    const { getGoCardlessClient, createMembershipSubscription, PLAN_TIER_MONTHLY_PENCE } = require('../_lib/gocardless');
    const monthlyPence = PLAN_TIER_MONTHLY_PENCE[member.plan_tier];
    if (mandateStatus === 'active' && monthlyPence && !member.gocardless_subscription_id) {
      try {
        const client = getGoCardlessClient();
        const subscription = await createMembershipSubscription(client, {
          mandateId: member.gocardless_mandate_id || links.mandate,
          amountPence: monthlyPence,
          name: `Radiant ${member.plan_tier === 'resident' ? 'Resident' : 'Core'} Membership`,
          idempotencyKey: `subscription:${member.id}`,
        });
        await supabase.from('members').update({ gocardless_subscription_id: subscription.id }).eq('id', member.id);
        await logAudit({
          actorId: null,
          actorName: 'GoCardless webhook',
          action: 'billing.subscription_created',
          entityType: 'member',
          entityId: member.id,
          details: { subscription_id: subscription.id, amount_pence: monthlyPence },
        });
      } catch (e) {
        console.error(`Failed to create membership subscription for member ${member.id}:`, e.message);
      }
    }
    return;
  }

  // Payment-status updates: match back to the booking via
  // bookings.gocardless_payment_id and reflect the outcome.
  if (resource_type === 'payments' && links.payment) {
    const statusMap = { confirmed: 'paid', failed: 'failed', cancelled: 'failed', charged_back: 'failed' };
    const paymentStatus = statusMap[action];
    if (!paymentStatus) return; // other actions (submitted, paid_out, etc.) don't change our status

    const { data: booking, error } = await supabase
      .from('bookings')
      .update({ payment_status: paymentStatus })
      .eq('gocardless_payment_id', links.payment)
      .select('id, member_id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!booking) return; // e.g. a subscription-generated payment, not a per-booking one — nothing to update

    await logAudit({
      actorId: null,
      actorName: 'GoCardless webhook',
      action: `billing.payment_${paymentStatus}`,
      entityType: 'booking',
      entityId: booking.id,
      details: { event_id: event.id },
    });
    return;
  }
}
