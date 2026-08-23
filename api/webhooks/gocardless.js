const crypto = require('crypto');
const { getSupabase } = require('../_lib/supabase');
const { logAudit } = require('../_lib/audit');
const {
  sendSessionPaymentConfirmedEmail, sendSessionPaymentFailedEmail, sendSubscriptionPaymentFailedEmail,
} = require('../_lib/email');
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
      // These were missing entirely — found while investigating why
      // mandate_status was never advancing in production: the CHECK
      // constraint on members.mandate_status didn't allow them either, so
      // even if GoCardless ever sent one of these actions, mandateStatus
      // would resolve to undefined here and the whole event would be
      // silently ignored below. Constraint extended in the same migration
      // that added gocardless_billing_request_id. Inferred 1:1 from the
      // Mandate resource's own status field (GoCardless names these
      // terminal-state actions identically to the status they produce,
      // same as the already-confirmed active/cancelled/failed/expired
      // above) rather than guessed from undocumented action names.
      consumed: 'consumed',
      blocked: 'blocked',
      suspended_by_payer: 'suspended_by_payer',
    };
    const mandateStatus = statusMap[action];
    if (!mandateStatus || !links.customer) return;

    const updates = { mandate_status: mandateStatus };
    if (mandateStatus === 'active' && links.mandate) updates.gocardless_mandate_id = links.mandate;

    const { data: member, error } = await supabase
      .from('members')
      .update(updates)
      .eq('gocardless_customer_id', links.customer)
      .select('id, first_name, last_name, email, plan_tier, custom_monthly_fee_pence, gocardless_subscription_id, gocardless_mandate_id')
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

    // Everything that happens once a mandate is confirmed active (email +
    // subscription setup) now lives in handleMandateBecameActive, shared
    // with api/billing/sync-mandate.js — the manual reconciliation tool
    // built after finding every mandate ever attempted sat stuck forever,
    // this webhook branch apparently never having successfully processed
    // an 'active' event in production despite mandates genuinely completing
    // on GoCardless's/the bank's side.
    if (mandateStatus === 'active') {
      const { handleMandateBecameActive } = require('../_lib/gocardless');
      await handleMandateBecameActive(supabase, member);
    }
    return;
  }

  // Payment-status updates: match back to the booking via
  // bookings.gocardless_payment_id — OR, if that was never set (e.g. the
  // billing_requests.fulfilled event that would normally set it never fired,
  // or its handler failed), fall back to links.billing_request, which is
  // present directly on every payment event created via Instant Bank Pay.
  // Real bug found by inspecting an actual webhook delivery: payments.
  // confirmed arrived and returned 200, but nothing matched because
  // gocardless_payment_id was still null — this event shouldn't depend on
  // an earlier one having already run successfully.
  if (resource_type === 'payments' && links.payment) {
    const statusMap = { confirmed: 'paid', failed: 'failed', cancelled: 'failed', charged_back: 'failed' };
    const paymentStatus = statusMap[action];
    if (!paymentStatus) return; // other actions (submitted, paid_out, etc.) don't change our status

    let findQuery = supabase.from('bookings').select('id, member_id, gocardless_payment_id, amount_pence, start_time, room:rooms(name), member:members!bookings_member_id_fkey(email, first_name, last_name)');
    findQuery = links.billing_request
      ? findQuery.or(`gocardless_payment_id.eq.${links.payment},gocardless_billing_request_id.eq.${links.billing_request}`)
      : findQuery.eq('gocardless_payment_id', links.payment);
    const { data: booking, error: findErr } = await findQuery.maybeSingle();
    if (findErr) throw new Error(findErr.message);

    if (booking) {
      // A specific session's payment (Instant Bank Pay, or a background
      // Direct Debit charge for an extra/ad-hoc booking).
      const { error } = await supabase
        .from('bookings')
        .update({ payment_status: paymentStatus, gocardless_payment_id: links.payment })
        .eq('id', booking.id);
      if (error) throw new Error(error.message);

      await logAudit({
        actorId: null,
        actorName: 'GoCardless webhook',
        action: `billing.payment_${paymentStatus}`,
        entityType: 'booking',
        entityId: booking.id,
        details: { event_id: event.id },
      });

      if (booking.member && booking.member.email) {
        const memberName = `${booking.member.first_name || ''} ${booking.member.last_name || ''}`.trim() || booking.member.email;
        const emailArgs = { to: booking.member.email, memberName, roomName: booking.room ? booking.room.name : 'Room', amountPence: booking.amount_pence, start: booking.start_time };
        try {
          if (paymentStatus === 'paid') await sendSessionPaymentConfirmedEmail(emailArgs);
          else await sendSessionPaymentFailedEmail(emailArgs);
        } catch (e) {
          console.error(`Failed to send session payment ${paymentStatus} email for booking ${booking.id}:`, e.message);
        }
      }
      return;
    }

    // No matching booking — most likely the monthly membership fee,
    // generated automatically by the subscription rather than through a
    // per-booking billing request. Match via the mandate on the payment to
    // find who it belongs to, and only treat it as the membership fee if
    // that member actually has a subscription (otherwise it's an unknown
    // payment we have no context for — logged, not emailed, rather than
    // guessing).
    if (!links.mandate) return;
    const { data: member, error: memberErr } = await supabase
      .from('members')
      .select('id, email, first_name, last_name, plan_tier, custom_monthly_fee_pence, gocardless_subscription_id')
      .eq('gocardless_mandate_id', links.mandate)
      .not('gocardless_subscription_id', 'is', null)
      .maybeSingle();
    if (memberErr) throw new Error(memberErr.message);
    if (!member) return; // genuinely nothing we recognise this payment as

    const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;
    // We don't have the payment amount here (it wasn't fetched from
    // GoCardless) — fall back to the tier's monthly figure, which is what
    // this payment almost certainly is. Same bug class caught in the same
    // audit as the sendSubscriptionStartedEmail fix (22 Aug): a member on
    // a negotiated custom_monthly_fee_pence deal would have this show the
    // wrong, standard rate instead of what they're actually charged.
    const { PLAN_TIER_MONTHLY_PENCE } = require('../_lib/gocardless');
    const amountPence = member.custom_monthly_fee_pence != null ? member.custom_monthly_fee_pence : (PLAN_TIER_MONTHLY_PENCE[member.plan_tier] || 0);

    await logAudit({
      actorId: null,
      actorName: 'GoCardless webhook',
      action: `billing.subscription_payment_${paymentStatus}`,
      entityType: 'member',
      entityId: member.id,
      details: { event_id: event.id, payment_id: links.payment },
    });

    try {
      if (paymentStatus === 'paid') {
        // No separate "confirmed" template for the monthly fee specifically
        // needed here — sendSubscriptionStartedEmail already told them once
        // it was set up; a recurring monthly confirmation for every single
        // charge would be noisy. Just log it.
      } else {
        await sendSubscriptionPaymentFailedEmail({ to: member.email, memberName, amountPence });
        // Per Radiant: the membership fee failing to collect should notify
        // Staff & Admin too, not just the member — unlike a one-off session
        // payment failure, this is recurring revenue actually not landing.
        const { notifyAdmins } = require('../_lib/notifyAdmins');
        await notifyAdmins(supabase, {
          relatedMemberId: member.id,
          subject: `Membership fee failed to collect — ${memberName}`,
          body: `${memberName}'s monthly membership fee (£${(amountPence / 100).toFixed(2)}) failed to collect. They've been notified to check their Direct Debit details.`,
        });
      }
    } catch (e) {
      console.error(`Failed to send subscription payment ${paymentStatus} notice for member ${member.id}:`, e.message);
    }
    return;
  }
}
