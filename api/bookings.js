const { getSupabase } = require('./_lib/supabase');
const { sendBookingConfirmation, sendTeamBookingNotice } = require('./_lib/email');
const { isNotificationEnabled } = require('./_lib/notificationSettings');
const { createCalendarEvent } = require('./_lib/google');
const { requireAuth } = require('./_lib/auth');
const { checkRateLimit } = require('./_lib/rateLimit');
const { calculateSessionChargeInPence, isIncludedInMembershipFee } = require('./_lib/pricing');
const { getGoCardlessClient, createOneOffPayment } = require('./_lib/gocardless');

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

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('bookings')
      .select(`
        id, start_time, end_time, status, notes, created_at, is_topup, payment_status, amount_pence, gocardless_payment_id, parent_booking_id,
        room:rooms ( id, name, emoji, floor ),
        member:members ( id, first_name, last_name, email, user_type, is_owner )
      `)
      .order('start_time', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ bookings: data });
  }

  if (req.method === 'POST') {
    const allowed = await checkRateLimit(`booking_create:${requester.id}`, 30, 3600);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many bookings created recently. Please wait a while before booking more.' });
    }

    const { room_id, member_id, start_time, end_time, notes, parent_booking_id } = req.body || {};
    if (!room_id || !member_id || !start_time || !end_time) {
      return res.status(400).json({ error: 'room_id, member_id, start_time, end_time are required' });
    }
    if (requester.user_type !== 'administrator' && member_id !== requester.id) {
      return res.status(403).json({ error: 'You can only create bookings for yourself' });
    }

    // Top-up rule: a 1-hour booking can never stand alone — it must be
    // attached to an existing (non-cancelled) booking belonging to the same
    // member. Top-ups are always a chargeable session (see pricing below).
    const durationMinutes = (new Date(end_time) - new Date(start_time)) / 60000;
    const isOneHour = durationMinutes === 60;
    let is_topup = false;

    if (parent_booking_id) {
      const { data: parentBooking, error: parentErr } = await supabase
        .from('bookings')
        .select('id, member_id, status')
        .eq('id', parent_booking_id)
        .maybeSingle();
      if (parentErr) return res.status(500).json({ error: parentErr.message });
      if (!parentBooking) return res.status(400).json({ error: 'The booking you\'re attaching this top-up to could not be found.' });
      if (parentBooking.status === 'cancelled') return res.status(400).json({ error: 'You can\'t attach a top-up to a cancelled booking.' });
      if (parentBooking.member_id !== member_id) return res.status(400).json({ error: 'A top-up must be attached to a booking for the same member.' });
      is_topup = true;
    } else if (isOneHour) {
      return res.status(400).json({ error: '1-hour sessions are only available as a top-up attached to an existing booking. Please select the booking to attach it to.' });
    }


    // Tier-based booking window rules:
    // - Community: rolling 7-day window
    // - Flex: rolling 30-day window
    // - Core / Resident: locked to their single agreed recurring day of the
    //   week for the length of their membership term — they don't pick dates
    //   themselves, they book their one fixed slot each week.
    let tierMember = requester;
    if (member_id !== requester.id) {
      const { data: otherMember, error: otherErr } = await supabase
        .from('members')
        .select('id, plan_tier, reserved_day_of_week, reserved_time_start, reserved_time_end, reserved_room_id, gocardless_mandate_id, mandate_status')
        .eq('id', member_id)
        .maybeSingle();
      if (otherErr) return res.status(500).json({ error: otherErr.message });
      tierMember = otherMember || {};
    }

    // Pricing: figure out what (if anything) this booking should be charged.
    // - Community: not charged through the app (existing behaviour, unchanged).
    // - Core/Resident: free if it's their included recurring slot for this
    //   week; otherwise priced as an extra session like Flex would be.
    // - Flex, and any top-up regardless of tier: always a chargeable session.
    // calculateSessionChargeInPence returns null when the brochure doesn't
    // define a rate for this duration/room-category combo (see pricing.js) —
    // that's routed to 'pending_manual' rather than guessed or charged £0.
    let finalPaymentStatus = 'not_required';
    let amountPence = null;

    const includedInMembership = await isIncludedInMembershipFee(supabase, tierMember, { room_id, start_time });

    const needsCharge = is_topup || tierMember.plan_tier === 'flex'
      || (['core', 'resident'].includes(tierMember.plan_tier) && !includedInMembership);

    if (needsCharge) {
      const { data: room } = await supabase.from('rooms').select('pricing_category').eq('id', room_id).maybeSingle();
      const durationMins = Math.round((new Date(end_time) - new Date(start_time)) / 60000);
      amountPence = calculateSessionChargeInPence(tierMember.plan_tier, durationMins, room && room.pricing_category);
      finalPaymentStatus = amountPence == null ? 'pending_manual' : 'pending';
    }

    const bookingStart = new Date(start_time);
    const now = new Date();
    const ROLLING_WINDOWS = { community: 7, flex: 30 };
    if (tierMember.plan_tier && ROLLING_WINDOWS[tierMember.plan_tier]) {
      const maxDays = ROLLING_WINDOWS[tierMember.plan_tier];
      const windowEnd = new Date(now.getTime() + maxDays * 24 * 60 * 60 * 1000);
      if (bookingStart > windowEnd) {
        return res.status(400).json({ error: `${tierMember.plan_tier === 'community' ? 'Community' : 'Flex'} members can only book up to ${maxDays} days ahead.` });
      }
    }
    if (tierMember.plan_tier && ['core', 'resident'].includes(tierMember.plan_tier)) {
      if (!tierMember.reserved_day_of_week) {
        return res.status(400).json({ error: `This member's recurring day hasn't been agreed yet. An admin needs to set their reserved session before bookings can be made.` });
      }
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const bookingDay = dayNames[bookingStart.getDay()];
      if (bookingDay !== tierMember.reserved_day_of_week) {
        return res.status(400).json({ error: `${tierMember.plan_tier === 'core' ? 'Core' : 'Resident'} members are booked on their agreed recurring day only: ${tierMember.reserved_day_of_week}.` });
      }
    }

    // Room booking rules: min/max duration and blackout dates
    const { data: roomRules, error: roomErr } = await supabase
      .from('rooms')
      .select('name, min_duration_minutes, max_duration_minutes, blackout_dates')
      .eq('id', room_id)
      .maybeSingle();
    if (roomErr) return res.status(500).json({ error: roomErr.message });
    if (roomRules) {
      const durationMinutes = (new Date(end_time) - new Date(start_time)) / 60000;
      if (roomRules.min_duration_minutes && durationMinutes < roomRules.min_duration_minutes) {
        return res.status(400).json({ error: `${roomRules.name} requires a minimum booking of ${roomRules.min_duration_minutes} minutes` });
      }
      if (roomRules.max_duration_minutes && durationMinutes > roomRules.max_duration_minutes) {
        return res.status(400).json({ error: `${roomRules.name} allows a maximum booking of ${roomRules.max_duration_minutes} minutes` });
      }
      const bookingDateStr = new Date(start_time).toISOString().slice(0, 10);
      if (roomRules.blackout_dates && roomRules.blackout_dates.includes(bookingDateStr)) {
        return res.status(400).json({ error: `${roomRules.name} is unavailable on ${bookingDateStr}` });
      }
    }

    // Overlap check: reject if the room already has a confirmed/pending
    // booking that overlaps the requested window.
    const { data: clashes, error: clashErr } = await supabase
      .from('bookings')
      .select('id')
      .eq('room_id', room_id)
      .neq('status', 'cancelled')
      .lt('start_time', end_time)
      .gt('end_time', start_time);
    if (clashErr) return res.status(500).json({ error: clashErr.message });
    if (clashes && clashes.length > 0) {
      return res.status(409).json({ error: 'This room is already booked for part of that time window.' });
    }

    const { data: booking, error } = await supabase
      .from('bookings')
      .insert({ room_id, member_id, start_time, end_time, notes, status: 'confirmed', parent_booking_id: parent_booking_id || null, is_topup, payment_status: finalPaymentStatus, amount_pence: amountPence })
      .select(`
        id, start_time, end_time, status, notes, is_topup, payment_status, amount_pence, parent_booking_id,
        room:rooms ( id, name, emoji, floor ),
        member:members ( id, first_name, last_name, email, user_type, google_calendar_connected, google_refresh_token )
      `)
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // If this booking needs charging and the member has a usable mandate,
    // attempt the Direct Debit payment now. Payment stays 'pending' either
    // way — GoCardless payments aren't instant, the webhook flips this to
    // 'paid' (or 'failed') once GoCardless actually reports the outcome.
    // A failure here (no mandate yet, GoCardless error, etc.) is logged but
    // never blocks the booking itself — staff can always collect manually.
    if (finalPaymentStatus === 'pending' && tierMember.mandate_status === 'active' && tierMember.gocardless_mandate_id) {
      try {
        const client = getGoCardlessClient();
        const payment = await createOneOffPayment(client, {
          mandateId: tierMember.gocardless_mandate_id,
          amountPence,
          description: `${room.name} booking — ${new Date(start_time).toLocaleDateString('en-GB')}`,
          idempotencyKey: booking.id,
        });
        await supabase.from('bookings').update({ gocardless_payment_id: payment.id }).eq('id', booking.id);
        booking.gocardless_payment_id = payment.id;
      } catch (e) {
        console.error(`GoCardless payment creation failed for booking ${booking.id}:`, e.message);
      }
    }

    const member = booking.member;
    const room = booking.room;

    // Fire-and-forget side effects — don't fail the booking if these fail,
    // just report what happened.
    const sideEffects = { email_sent: false, calendar_synced: false, warnings: [] };

    try {
      if (await isNotificationEnabled('booking_confirmation')) {
        await sendBookingConfirmation({
          to: member.email,
          memberName: `${member.first_name} ${member.last_name}`,
          roomName: room.name,
          start: booking.start_time,
          end: booking.end_time,
        });
        sideEffects.email_sent = true;
      }
    } catch (e) {
      sideEffects.warnings.push(`Email not sent: ${e.message}`);
    }

    try {
      await sendTeamBookingNotice({
        memberName: `${member.first_name} ${member.last_name}`,
        roomName: room.name,
        start: booking.start_time,
        end: booking.end_time,
      });
    } catch (e) {
      // non-critical - the practitioner's own confirmation already succeeded
    }

    if (member.google_calendar_connected && member.google_refresh_token) {
      try {
        const event = await createCalendarEvent({
          refreshToken: member.google_refresh_token,
          summary: `${room.name} — Radiant Booking`,
          description: notes || '',
          startISO: booking.start_time,
          endISO: booking.end_time,
        });
        await supabase.from('bookings').update({ google_event_id: event.id }).eq('id', booking.id);
        sideEffects.calendar_synced = true;
      } catch (e) {
        sideEffects.warnings.push(`Calendar sync failed: ${e.message}`);
      }
    }

    return res.status(201).json({ booking, ...sideEffects });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
