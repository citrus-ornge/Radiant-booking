const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');
// _lib/gocardless is required lazily inside the handler — see mandate.js
// for why (a load failure there shouldn't take this whole function down
// before it even reaches the GoCardless-specific code).

// POST /api/billing/pay-now { booking_id }
// Collects payment for a single booking immediately via Instant Bank Pay
// (GBP, Faster Payments) instead of waiting on the ~6-day standard Direct
// Debit collection timeline. The member is redirected to their banking app
// to authorise; funds typically arrive same day (if authorised before 11am)
// or the next business day.
//
// Deliberately does NOT bundle a mandate_request into the same Billing
// Request, even though a member with no active mandate could use one.
// Confirmed against a real GoCardless sandbox event: when a mandate is
// created alongside an Instant Bank Pay payment this way, GoCardless ties
// it to the faster_payments scheme the payment actually used (regardless
// of the bacs scheme we requested) and marks it 'consumed' — single-use,
// cannot be reused for future payments — the moment that first payment is
// created. So this "dual flow" never actually sets up ongoing Direct
// Debit; it silently creates a dead mandate. Direct Debit setup stays a
// fully separate action (see mandate.js) so it always uses a genuine,
// reusable bacs mandate.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let member;
  try {
    const auth = await requireAuth(req);
    member = auth.member;
    if (!member) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  const { booking_id } = req.body || {};
  if (!booking_id) return res.status(400).json({ error: 'booking_id is required' });

  const supabase = getSupabase();

  const { data: booking, error: bookingErr } = await supabase
    .from('bookings')
    .select('id, member_id, amount_pence, payment_status, gocardless_payment_id, start_time, room:rooms(name)')
    .eq('id', booking_id)
    .maybeSingle();
  if (bookingErr) return res.status(500).json({ error: bookingErr.message });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.member_id !== member.id && member.user_type !== 'administrator') {
    return res.status(403).json({ error: 'You can only pay for your own bookings' });
  }
  if (booking.payment_status !== 'pending') {
    return res.status(400).json({ error: 'This booking isn\'t awaiting payment.' });
  }
  if (!booking.amount_pence) {
    // pending_manual bookings have no confirmed price — Instant Bank Pay
    // needs a fixed amount, so these still have to be invoiced manually.
    return res.status(400).json({ error: 'This booking doesn\'t have a set price yet — please contact Staff & Admin.' });
  }
  if (booking.gocardless_payment_id) {
    return res.status(400).json({ error: 'A payment has already been started for this booking.' });
  }

  let client, customerLinksFor, persistNewCustomerId;
  try {
    const gc = require('../_lib/gocardless');
    customerLinksFor = gc.customerLinksFor;
    persistNewCustomerId = gc.persistNewCustomerId;
    client = gc.getGoCardlessClient();
  } catch (e) {
    console.error('Failed to load/init GoCardless client:', e.message);
    return res.status(503).json({ error: 'Payments are not configured yet. Please contact Staff & Admin.' });
  }

  try {
    // See customerLinksFor's comment in _lib/gocardless.js — no separate
    // "create the customer first" call (that's the restricted live
    // endpoint GoCardless support identified in ticket #4423820). Link an
    // existing customer if we have one; otherwise GoCardless creates one as
    // part of this Billing Request, and persistNewCustomerId picks it up.
    const billingRequestParams = {
      payment_request: {
        amount: String(booking.amount_pence),
        currency: 'GBP',
        scheme: 'faster_payments',
        description: `${booking.room ? booking.room.name : 'Room'} booking — ${new Date(booking.start_time).toLocaleDateString('en-GB')}`,
      },
    };
    const links = customerLinksFor(member);
    if (links) billingRequestParams.links = links;

    const billingRequest = await client.billingRequests.create(billingRequestParams);
    await persistNewCustomerId(supabase, member, billingRequest);

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const billingRequestFlow = await client.billingRequestFlows.create({
      links: { billing_request: billingRequest.id },
      redirect_uri: `${origin}/#my-bookings?payment=complete`,
      exit_uri: `${origin}/#my-bookings?payment=cancelled`,
      // See mandate.js for why this is prefilled_customer, not lock_customer_details.
      prefilled_customer: {
        given_name: member.first_name || undefined,
        family_name: member.last_name || undefined,
        email: member.email || undefined,
      },
    });

    await supabase.from('bookings').update({ gocardless_billing_request_id: billingRequest.id }).eq('id', booking.id);

    await logAudit({
      actorId: member.id,
      actorName: `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email,
      action: 'billing.instant_pay_started',
      entityType: 'booking',
      entityId: booking.id,
      details: { billing_request_id: billingRequest.id, amount_pence: booking.amount_pence },
    });

    return res.status(200).json({ authorisation_url: billingRequestFlow.authorisation_url });
  } catch (e) {
    const detail = (e.errors && e.errors.length) ? e.errors.map(x => x.message || x.reason).join('; ') : e.message;
    console.error(`Instant Bank Pay setup failed for booking ${booking.id}:`, detail, 'request_id:', e.request_id || null);
    return res.status(502).json({ error: 'Could not start payment. Please try again or contact Staff & Admin.' });
  }
};
