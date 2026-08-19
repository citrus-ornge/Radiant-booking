const { getSupabase } = require('./_lib/supabase');
const { sendBookingConfirmation, sendTeamBookingNotice, sendPatientInviteEmail } = require('./_lib/email');
const { isNotificationEnabled } = require('./_lib/notificationSettings');
const { createCalendarEvent } = require('./_lib/google');
const { requireAuth } = require('./_lib/auth');
const { checkRateLimit } = require('./_lib/rateLimit');
const { calculateSessionChargeInPence, isIncludedInMembershipFee } = require('./_lib/pricing');
const { generateBookingIcs, bookingIcsUid } = require('./_lib/ics');
// _lib/gocardless is deliberately NOT required at the top of this file.
// It's only needed for the one payment-attempt branch inside POST, and
// requiring it lazily there means a problem in that library (or how it
// bundles) can only ever break that one attempt-payment step — not every
// GET/POST this whole file handles, including plain booking reads that have
// nothing to do with payments.

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
        patient_email, patient_name, patient_notes, patient_invite_sent_at,
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

    const { room_id, member_id, start_time, end_time, notes, parent_booking_id, patient_email, patient_name, patient_notes } = req.body || {};
    if (!room_id || !member_id || !start_time || !end_time) {
      return res.status(400).json({ error: 'room_id, member_id, start_time, end_time are required' });
    }
    if (requester.user_type !== 'administrator' && member_id !== requester.id) {
      return res.status(403).json({ error: 'You can only create bookings for yourself' });
    }

    // Admin-only rooms (e.g. Aesthetics — team review 19 Aug 2026): the
    // room stays visible in the self-service list for transparency, but
    // only Staff & Admin can actually complete a booking for it. This is
    // the authoritative check; the client also hides the option to select
    // it as a courtesy so people don't hit this error in the first place.
    const { data: roomCheck, error: roomCheckErr } = await supabase.from('rooms').select('name, admin_only').eq('id', room_id).maybeSingle();
    if (roomCheckErr) return res.status(500).json({ error: roomCheckErr.message });
    if (roomCheck && roomCheck.admin_only && requester.user_type !== 'administrator') {
      return res.status(403).json({ error: `${roomCheck.name} is reserved for Staff & Admin — contact them if you need this room.` });
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
    // - Core / Resident: locked to their agreed recurring day(s) of the
    //   week for the length of their membership term — they don't pick
    //   dates themselves, they book their fixed slot(s) each week. A member
    //   can have more than one slot (e.g. full day Monday + half day Friday).
    let tierMember = requester;
    if (member_id !== requester.id) {
      const { data: otherMember, error: otherErr } = await supabase
        .from('members')
        .select('id, plan_tier, gocardless_mandate_id, mandate_status')
        .eq('id', member_id)
        .maybeSingle();
      if (otherErr) return res.status(500).json({ error: otherErr.message });
      tierMember = otherMember || {};
    }

    let recurringSlots = [];
    if (['core', 'resident'].includes(tierMember.plan_tier)) {
      const { data: slots, error: slotsErr } = await supabase
        .from('member_recurring_slots')
        .select('day_of_week, time_start, time_end, room_id')
        .eq('member_id', tierMember.id || member_id);
      if (slotsErr) return res.status(500).json({ error: slotsErr.message });
      recurringSlots = slots || [];
    }

    // Pricing: figure out what (if anything) this booking should be charged.
    // - Community: not charged through the app (existing behaviour, unchanged).
    // - Core/Resident: free if it matches one of their included recurring
    //   slots for this week; otherwise priced as an extra session like Flex
    //   would be.
    // - Flex, and any top-up regardless of tier: always a chargeable session.
    // calculateSessionChargeInPence returns null when the brochure doesn't
    // define a rate for this duration/room-category combo (see pricing.js) —
    // that's routed to 'pending_manual' rather than guessed or charged £0.
    let finalPaymentStatus = 'not_required';
    let amountPence = null;

    const includedInMembership = await isIncludedInMembershipFee(supabase, tierMember, recurringSlots, { room_id, start_time });

    const needsCharge = is_topup || tierMember.plan_tier === 'flex'
      || (['core', 'resident'].includes(tierMember.plan_tier) && !includedInMembership);

    if (needsCharge) {
      const { data: pricingRoom } = await supabase.from('rooms').select('pricing_category').eq('id', room_id).maybeSingle();
      const durationMins = Math.round((new Date(end_time) - new Date(start_time)) / 60000);
      amountPence = calculateSessionChargeInPence(tierMember.plan_tier, durationMins, pricingRoom && pricingRoom.pricing_category);
      finalPaymentStatus = amountPence == null ? 'pending_manual' : 'pending';
    }

    const bookingStart = new Date(start_time);
    const now = new Date();
    // Core/Resident can also book ad-hoc extra days beyond their agreed
    // slot(s) (see isIncludedInMembershipFee above — those get charged,
    // this window rule doesn't distinguish, it just bounds how far ahead
    // ANY booking of theirs can be), using the same 30-day window as Flex.
    const ROLLING_WINDOWS = { community: 7, flex: 30, core: 30, resident: 30 };
    if (tierMember.plan_tier && ROLLING_WINDOWS[tierMember.plan_tier]) {
      const maxDays = ROLLING_WINDOWS[tierMember.plan_tier];
      const windowEnd = new Date(now.getTime() + maxDays * 24 * 60 * 60 * 1000);
      if (bookingStart > windowEnd) {
        return res.status(400).json({ error: `${{ community: 'Community', flex: 'Flex', core: 'Core', resident: 'Resident' }[tierMember.plan_tier]} members can only book up to ${maxDays} days ahead.` });
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
      .insert({
        room_id, member_id, start_time, end_time, notes, status: 'confirmed', parent_booking_id: parent_booking_id || null,
        is_topup, payment_status: finalPaymentStatus, amount_pence: amountPence,
        patient_email: patient_email || null, patient_name: patient_name || null, patient_notes: patient_notes || null,
      })
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
        const { getGoCardlessClient, createOneOffPayment } = require('./_lib/gocardless');
        const client = getGoCardlessClient();
        const payment = await createOneOffPayment(client, {
          mandateId: tierMember.gocardless_mandate_id,
          amountPence,
          description: `${booking.room ? booking.room.name : 'Room'} booking — ${new Date(start_time).toLocaleDateString('en-GB')}`,
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

    // Universal calendar invite — attached to both emails below regardless
    // of whether the member has connected Google Calendar. Works in Gmail,
    // Outlook, Apple Mail etc. with zero setup; the OAuth direct-sync
    // further down is a bonus on top of this for members who've connected,
    // not a replacement for it.
    const icsContent = generateBookingIcs({
      uid: bookingIcsUid(booking.id),
      summary: `${room.name} — Radiant Booking`,
      description: notes || '',
      location: room.name,
      startISO: booking.start_time,
      endISO: booking.end_time,
      sequence: 0,
      method: 'REQUEST',
    });

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
          icsContent,
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
        icsContent,
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

    // Optional: the practitioner invited their own patient to this booking
    // (address, map link, appointment time, a note that reception will meet
    // them) — an external third party, not a system user, so this is
    // deliberately separate from the practitioner's own confirmation above.
    if (patient_email) {
      try {
        const patientIcs = generateBookingIcs({
          uid: `patient-${booking.id}@booking.radiantfr.com`, // distinct UID from the practitioner's own invite — same booking, but the patient's calendar entry is conceptually separate
          summary: `Appointment with ${member.first_name} ${member.last_name} — Radiant`,
          description: patient_notes || '',
          location: room.name,
          startISO: booking.start_time,
          endISO: booking.end_time,
          sequence: 0,
          method: 'REQUEST',
        });
        await sendPatientInviteEmail({
          to: patient_email,
          patientName: patient_name || '',
          practitionerName: `${member.first_name} ${member.last_name}`.trim(),
          roomName: room.name,
          start: booking.start_time,
          end: booking.end_time,
          notes: patient_notes || '',
          icsContent: patientIcs,
        });
        await supabase.from('bookings').update({ patient_invite_sent_at: new Date().toISOString() }).eq('id', booking.id);
        sideEffects.patient_invite_sent = true;
      } catch (e) {
        sideEffects.warnings.push(`Patient invite not sent: ${e.message}`);
        sideEffects.patient_invite_sent = false;
      }
    }

    return res.status(201).json({ booking, ...sideEffects });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
