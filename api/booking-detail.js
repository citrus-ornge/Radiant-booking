const { getSupabase } = require('./_lib/supabase');
const { sendCancellationAlert } = require('./_lib/email');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');
const { isNotificationEnabled } = require('./_lib/notificationSettings');
const { generateBookingIcs, bookingIcsUid } = require('./_lib/ics');

// Real, unresolved 405 found live on PATCH /api/bookings/{id} (the bracket
// dynamic route in the api/bookings/ folder): confirmed via direct browser
// fetch() that the request genuinely leaves the client with the correct
// method, URL and auth header, and gets back a real 405 — but it never
// once appears in Vercel's function invocation logs, and the Vercel
// Firewall shows zero denied traffic matching. Ruled out directly:
// code (clean), local module load (succeeds), device/network/incognito
// (identical everywhere), page source (matches repo exactly), a redundant
// vercel.json rewrite rule (removed, no change). This endpoint sidesteps
// the suspect pattern entirely — a query-param id instead of a bracket
// path segment, and a name that doesn't collide with the sibling
// api/bookings.js file the way api/bookings/[id].js's containing folder
// does — rather than keep chasing why the original route fails.
module.exports = async (req, res) => {
  // Wrapping the whole handler: a bare 500 with no body was showing up
  // live for the very first real invocation of this logic (the original
  // bracket route never once actually ran in production, so any bug here
  // was never exposed until now). This surfaces the real error message
  // and stack instead of a blank 500, rather than guessing again.
  try {
    return await handleBookingDetail(req, res);
  } catch (e) {
    console.error('Unhandled error in booking-detail:', e);
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
};

async function handleBookingDetail(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id is required' });
  const supabase = getSupabase();

  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  const { data: existing, error: existingErr } = await supabase.from('bookings').select('member_id').eq('id', id).single();
  if (existingErr) return res.status(404).json({ error: 'Booking not found' });
  if (requester.user_type !== 'administrator' && existing.member_id !== requester.id) {
    return res.status(403).json({ error: 'You can only manage your own bookings' });
  }

  if (req.method === 'PATCH') {
    const { status, patient_email, patient_name, patient_notes } = req.body || {};

    // Two distinct kinds of update sharing this endpoint: a status change
    // (existing behaviour), or adding/editing patient details on an
    // existing booking — the latter deliberately has no time restriction
    // ("add whenever"), so a practitioner can invite their patient right
    // when booking, or come back and add it later, or update the notes
    // before the appointment.
    if (patient_email !== undefined || patient_name !== undefined || patient_notes !== undefined) {
      if (patient_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patient_email)) {
        return res.status(400).json({ error: 'Please enter a valid email address' });
      }
      const updates = {};
      if (patient_email !== undefined) updates.patient_email = patient_email || null;
      if (patient_name !== undefined) updates.patient_name = patient_name || null;
      if (patient_notes !== undefined) updates.patient_notes = patient_notes || null;

      const { data: booking, error } = await supabase
        .from('bookings')
        .update(updates)
        .eq('id', id)
        .select(`
          id, start_time, end_time, patient_email, patient_name, patient_notes,
          room:rooms ( name ),
          member:members!bookings_member_id_fkey ( first_name, last_name )
        `)
        .single();
      if (error) return res.status(500).json({ error: error.message });

      let patient_invite_sent = false;
      if (updates.patient_email) {
        try {
          const { generateBookingIcs } = require('./_lib/ics');
          const { sendPatientInviteEmail } = require('./_lib/email');
          const patientIcs = generateBookingIcs({
            uid: `patient-${booking.id}@booking.radiantfr.com`,
            summary: `Appointment with ${booking.member.first_name} ${booking.member.last_name} — Radiant`,
            description: booking.patient_notes || '',
            location: booking.room.name,
            startISO: booking.start_time,
            endISO: booking.end_time,
            sequence: 0,
            method: 'REQUEST',
          });
          await sendPatientInviteEmail({
            to: booking.patient_email,
            patientName: booking.patient_name || '',
            practitionerName: `${booking.member.first_name} ${booking.member.last_name}`.trim(),
            roomName: booking.room.name,
            start: booking.start_time,
            end: booking.end_time,
            notes: booking.patient_notes || '',
            icsContent: patientIcs,
          });
          await supabase.from('bookings').update({ patient_invite_sent_at: new Date().toISOString() }).eq('id', id);
          patient_invite_sent = true;
        } catch (e) {
          // don't fail the request over email issues — the booking's own
          // patient details are already saved successfully either way
        }
      }

      logAudit({
        actorId: requester.id, actorName: `${requester.first_name} ${requester.last_name}`.trim(),
        action: 'booking.patient_details_updated', entityType: 'booking', entityId: id,
        details: { patient_invited: !!updates.patient_email },
      });

      return res.status(200).json({ booking, patient_invite_sent });
    }

    if (!['confirmed', 'pending', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'status must be confirmed, pending, or cancelled' });
    }

    const updates = { status };
    if (status === 'cancelled') {
      // Cancellation tracking (team review 19 Aug 2026): "we track this in
      // platform" — who cancelled, when, and for Flex specifically whether
      // it was inside or outside the 7-day notice window. This never
      // processes a refund itself — Staff & Admin still handle that
      // manually in the GoCardless dashboard — it just gives them the
      // fact to act on instead of having to reconstruct it from memory.
      const { data: forNotice } = await supabase
        .from('bookings')
        .select('start_time, member:members!bookings_member_id_fkey(plan_tier)')
        .eq('id', id)
        .maybeSingle();
      const noticeHours = forNotice ? (new Date(forNotice.start_time) - new Date()) / 3600000 : null;
      updates.cancelled_at = new Date().toISOString();
      updates.cancelled_by = requester.id;
      updates.cancellation_notice_hours = noticeHours;
      updates.cancellation_within_notice_window = (forNotice && forNotice.member && forNotice.member.plan_tier === 'flex' && noticeHours != null)
        ? noticeHours >= 168
        : null;
    }

    const { data: booking, error } = await supabase
      .from('bookings')
      .update(updates)
      .eq('id', id)
      .select(`
        id, start_time, end_time, status, cancelled_at, cancelled_by, cancellation_notice_hours, cancellation_within_notice_window,
        room:rooms ( name ),
        member:members!bookings_member_id_fkey ( email )
      `)
      .single();
    if (error) return res.status(500).json({ error: error.message });

    logAudit({
      actorId: requester.id, actorName: `${requester.first_name} ${requester.last_name}`.trim(),
      action: status === 'cancelled' ? 'booking.cancelled' : 'booking.updated', entityType: 'booking', entityId: id,
      details: { status, room: booking.room ? booking.room.name : null, ...(status === 'cancelled' ? { within_notice_window: booking.cancellation_within_notice_window, notice_hours: booking.cancellation_notice_hours != null ? Math.round(booking.cancellation_notice_hours) : null } : {}) },
    });

    let email_sent = false;
    if (status === 'cancelled' && await isNotificationEnabled('cancellation_alert')) {
      try {
        // Same UID as the original confirmation invite (bookingIcsUid is
        // deterministic from the booking id) — that's what lets calendar
        // apps match this to the earlier event and remove/grey it out,
        // rather than just leaving a stray attachment sitting in the inbox.
        const icsContent = generateBookingIcs({
          uid: bookingIcsUid(booking.id),
          summary: `${booking.room.name} — Radiant Booking`,
          startISO: booking.start_time,
          endISO: booking.end_time,
          sequence: 1,
          method: 'CANCEL',
        });
        await sendCancellationAlert({
          to: booking.member.email,
          roomName: booking.room.name,
          start: booking.start_time,
          icsContent,
        });
        email_sent = true;
      } catch (e) {
        // don't fail the request over email issues
      }
    }
    return res.status(200).json({ booking, email_sent });
  }

  if (req.method === 'DELETE') {
    const { error } = await supabase.from('bookings').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  res.status(405).json({ error: 'Method not allowed' });
}
