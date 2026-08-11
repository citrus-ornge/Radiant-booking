const { getSupabase } = require('../_lib/supabase');
const { sendCancellationAlert } = require('../_lib/email');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');
const { isNotificationEnabled } = require('../_lib/notificationSettings');
const { generateBookingIcs, bookingIcsUid } = require('../_lib/ics');

module.exports = async (req, res) => {
  const { id } = req.query;
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
          member:members ( first_name, last_name )
        `)
        .single();
      if (error) return res.status(500).json({ error: error.message });

      let patient_invite_sent = false;
      if (updates.patient_email) {
        try {
          const { generateBookingIcs } = require('../_lib/ics');
          const { sendPatientInviteEmail } = require('../_lib/email');
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
    const { data: booking, error } = await supabase
      .from('bookings')
      .update({ status })
      .eq('id', id)
      .select(`
        id, start_time, end_time, status,
        room:rooms ( name ),
        member:members ( email )
      `)
      .single();
    if (error) return res.status(500).json({ error: error.message });

    logAudit({
      actorId: requester.id, actorName: `${requester.first_name} ${requester.last_name}`.trim(),
      action: status === 'cancelled' ? 'booking.cancelled' : 'booking.updated', entityType: 'booking', entityId: id,
      details: { status, room: booking.room ? booking.room.name : null },
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
};
