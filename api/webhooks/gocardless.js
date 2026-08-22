const crypto = require('crypto');
const { getSupabase } = require('../_lib/supabase');
const { logAudit } = require('../_lib/audit');
const {
  sendMandateActiveEmail, sendSessionPaymentConfirmedEmail, sendSessionPaymentFailedEmail,
  sendSubscriptionStartedEmail, sendSubscriptionPaymentFailedEmail,
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

    const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;

    if (mandateStatus === 'active') {
      try {
        await sendMandateActiveEmail({ to: member.email, memberName });
      } catch (e) {
        console.error(`Failed to send mandate-active email to member ${member.id}:`, e.message);
      }
    }

    // Core/Resident have a flat monthly membership fee on top of any
    // per-session charges (confirmed by Radiant) — set up the recurring
    // subscription the moment their mandate goes active. ensureMembership
    // Subscription is idempotent and shared with the manual admin recovery
    // action and the daily safety-net cron, so a failure here isn't the
    // only chance to get this right.
    // NOTE: PLAN_TIER_MONTHLY_PENCE amounts are still placeholders pending
    // confirmation against the brochure (see api/_lib/gocardless.js) — do
    // not go live on real payment collection until those are confirmed.
    if (mandateStatus === 'active') {
      const { ensureMembershipSubscription, PLAN_TIER_MONTHLY_PENCE } = require('../_lib/gocardless');
      const result = await ensureMembershipSubscription(supabase, member);
      if (result.created) {
        await logAudit({
          actorId: null, actorName: 'GoCardless webhook', action: 'billing.subscription_created',
          entityType: 'member', entityId: member.id, details: { subscription_id: result.subscriptionId },
        });
        try {
          const tierLabel = member.plan_tier === 'resident' ? 'Resident' : 'Core';
          await sendSubscriptionStartedEmail({ to: member.email, memberName, tierLabel, amountPence: PLAN_TIER_MONTHLY_PENCE[member.plan_tier] });
        } catch (e) {
          console.error(`Failed to send subscription-started email to member ${member.id}:`, e.message);
        }
      } else if (result.failed) {
        // Not just console.error — this is money that would otherwise never
        // get collected with nobody the wiser. Log it AND tell an admin directly.
        console.error(`Failed to create membership subscription for member ${member.id}:`, result.error);
        await logAudit({
          actorId: null, actorName: 'GoCardless webhook', action: 'billing.subscription_creation_failed',
          entityType: 'member', entityId: member.id, details: { error: result.error },
        });
        const { data: admins } = await supabase.from('members').select('id').eq('user_type', 'administrator').eq('status', 'active');
        for (const admin of admins || []) {
          await supabase.from('messages').insert({
            sender_id: member.id, recipient_id: admin.id,
            body: `⚠ Failed to set up ${memberName}'s monthly membership subscription after their Direct Debit went active (${result.error}). Their recurring slot fee won't be collected until this is fixed — use 'Create subscription now' in Manage Member, or check the GoCardless dashboard directly.`,
          });
        }
      }
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
      .select('id, email, first_name, last_name, plan_tier, gocardless_subscription_id')
      .eq('gocardless_mandate_id', links.mandate)
      .not('gocardless_subscription_id', 'is', null)
      .maybeSingle();
    if (memberErr) throw new Error(memberErr.message);
    if (!member) return; // genuinely nothing we recognise this payment as

    const memberName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email;
    // We don't have the payment amount here (it wasn't fetched from
    // GoCardless) — fall back to the tier's monthly figure, which is what
    // this payment almost certainly is.
    const { PLAN_TIER_MONTHLY_PENCE } = require('../_lib/gocardless');
    const amountPence = PLAN_TIER_MONTHLY_PENCE[member.plan_tier] || 0;

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
        const { data: admins } = await supabase.from('members').select('id').eq('user_type', 'administrator').eq('status', 'active');
        for (const admin of admins || []) {
          await supabase.from('messages').insert({
            sender_id: member.id, recipient_id: admin.id,
            body: `⚠ ${memberName}'s monthly membership fee (£${(amountPence / 100).toFixed(2)}) failed to collect. They've been notified to check their Direct Debit details.`,
          });
        }
      }
    } catch (e) {
      console.error(`Failed to send subscription payment ${paymentStatus} notice for member ${member.id}:`, e.message);
    }
    return;
  }
}
