const { Resend } = require('resend');

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Missing RESEND_API_KEY env var');
  return new Resend(key);
}

// booking.radiantfr.com is now verified in Resend (as of 30 Jul 2026),
// so real emails can go to any address, not just the account owner's own.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Radiant Booking <booking@booking.radiantfr.com>';

async function sendBookingConfirmation({ to, memberName, roomName, start, end, icsContent }) {
  const resend = getResend();
  const dateStr = new Date(start).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const endStr = new Date(end).toLocaleString('en-GB', { timeStyle: 'short' });
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `Booking confirmed: ${roomName}`,
    text: `Hi ${memberName},

Your booking is confirmed:

${roomName}
${dateStr} – ${endStr}

A calendar invite is attached — most email apps will show an "Add to calendar" option.

A couple of friendly reminders that help everyone using the space:
- Please arrive on time so the room's ready for the person after you
- Leave the room as you'd like to find it - tidy, restocked, and ready for the next booking
- If your plans change, please cancel or amend as early as you can so someone else can use the slot

Thanks for being part of what makes Radiant a great place to work. See you then!

— Radiant Booking`,
    attachments: icsContent ? [{
      filename: 'invite.ics',
      content: Buffer.from(icsContent).toString('base64'),
      contentType: 'text/calendar; charset=utf-8; method=REQUEST',
    }] : undefined,
  });
}

async function sendTeamBookingNotice({ memberName, roomName, start, end, icsContent }) {
  const resend = getResend();
  const dateStr = new Date(start).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const endStr = new Date(end).toLocaleString('en-GB', { timeStyle: 'short' });
  return resend.emails.send({
    from: FROM_EMAIL,
    to: ['support@radiantfr.com'],
    subject: `New booking: ${roomName} — ${memberName}`,
    text: `A new room booking has been made:

${memberName} — ${roomName}
${dateStr} – ${endStr}

— Radiant Booking`,
    attachments: icsContent ? [{
      filename: 'invite.ics',
      content: Buffer.from(icsContent).toString('base64'),
      contentType: 'text/calendar; charset=utf-8; method=REQUEST',
    }] : undefined,
  });
}

async function sendCancellationAlert({ to, roomName, start, icsContent }) {
  const resend = getResend();
  const dateStr = new Date(start).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `Booking cancelled: ${roomName}`,
    text: `The booking for ${roomName} on ${dateStr} has been cancelled.${icsContent ? ' The calendar invite attached will remove it from your calendar automatically in most apps.' : ''}\n\n— Radiant Booking`,
    attachments: icsContent ? [{
      filename: 'cancel.ics',
      content: Buffer.from(icsContent).toString('base64'),
      contentType: 'text/calendar; charset=utf-8; method=CANCEL',
    }] : undefined,
  });
}

// ── Payment / billing emails ──
// Added per the pre-launch review: previously the GoCardless webhook never
// emailed the member anything at all — mandate going active, a payment
// confirming or failing, a subscription starting all happened silently,
// with only the in-app state to show for it.

async function sendMandateActiveEmail({ to, memberName }) {
  const resend = getResend();
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: 'Your Direct Debit is now active',
    text: `Hi ${memberName},

Your Direct Debit with Radiant is now active. Any session charges and your membership fee (if applicable) will be collected automatically from here on.

You can review or update your bank details any time from My Profile.

— Radiant Booking`,
  });
}

async function sendSessionPaymentConfirmedEmail({ to, memberName, roomName, amountPence, start }) {
  const resend = getResend();
  const dateStr = new Date(start).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const amount = `£${(amountPence / 100).toFixed(2)}`;
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `Payment confirmed: ${roomName} — ${amount}`,
    text: `Hi ${memberName},

Payment confirmed for your session:

${roomName}
${dateStr}
${amount}

— Radiant Booking`,
  });
}

async function sendSessionPaymentFailedEmail({ to, memberName, roomName, amountPence, start }) {
  const resend = getResend();
  const dateStr = new Date(start).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const amount = `£${(amountPence / 100).toFixed(2)}`;
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `Payment failed: ${roomName}`,
    text: `Hi ${memberName},

We weren't able to collect payment for your session:

${roomName}
${dateStr}
${amount}

Please check your Direct Debit details on My Profile, or use "Pay now" on the booking to pay instantly instead. If this keeps happening, contact Staff & Admin.

— Radiant Booking`,
  });
}

async function sendSubscriptionStartedEmail({ to, memberName, tierLabel, amountPence }) {
  const resend = getResend();
  const amount = `£${(amountPence / 100).toFixed(2)}`;
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `Your ${tierLabel} membership fee is now set up`,
    text: `Hi ${memberName},

Your ${tierLabel} monthly membership fee (${amount}/month) is now set up and will be collected automatically via Direct Debit each month.

You can review this any time from My Profile.

— Radiant Booking`,
  });
}

async function sendSubscriptionPaymentFailedEmail({ to, memberName, amountPence }) {
  const resend = getResend();
  const amount = `£${(amountPence / 100).toFixed(2)}`;
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `We couldn't collect your monthly membership fee`,
    text: `Hi ${memberName},

We weren't able to collect your ${amount} monthly membership fee via Direct Debit.

Please check your bank details are up to date on My Profile. If this keeps happening, contact Staff & Admin — your membership and recurring slot aren't affected while this gets sorted.

— Radiant Booking`,
  });
}

async function sendReminder({ to, memberName, roomName, start, hoursBefore }) {
  const resend = getResend();
  const dateStr = new Date(start).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `Reminder: ${roomName} in ${hoursBefore}`,
    text: `Hi ${memberName},\n\nJust a reminder — your booking for ${roomName} is on ${dateStr}.\n\n— Radiant Booking`,
  });
}

const ROLE_LABELS = { administrator: 'Staff & Admin member', practitioner: 'practitioner', member: 'member', guest: 'guest' };

async function sendInvite({ to, userType, note, inviteUrl }) {
  const resend = getResend();
  const roleText = ROLE_LABELS[userType] || userType;
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `You're invited to Radiant Booking`,
    text: `You've been invited to join Radiant Booking as a ${roleText}.\n${note ? `\nNote: ${note}\n` : ''}\nAccept here: ${inviteUrl}\n\nThis invite expires in 7 days.`,
  });
}

const TIER_LABELS = { community: 'Community', flex: 'Flex', core: 'Core', resident: 'Resident' };

function tierSectionFor(planTier) {
  if (planTier && TIER_LABELS[planTier]) {
    return `\n\nYour room membership tier: ${TIER_LABELS[planTier]}\nYou can view the full details of your membership any time from your Profile page.`;
  }
  return `\n\nRoom membership tier: not yet set\nYou can select your room membership tier (Community, Flex, Core or Resident) from your Profile page.`;
}

async function sendWelcomeEmail({ to, firstName, userType, planTier, directoryTier, isOwner }) {
  const resend = getResend();
  const name = firstName || 'there';
  const appUrl = process.env.PUBLIC_APP_URL || 'https://radiant-booking.vercel.app';

  if (isOwner) {
    const body = `Hi ${name},

Your Radiant Booking Platform account is ready — with full Super Admin access as the clinic owner.

As Super Admin, you have complete oversight of the platform:
- Full visibility and control over rooms, members, bookings and invitations
- The ability to manage every other Staff & Admin account
- Real-time booking activity across the whole clinic
- Everything Staff & Admin and practitioner accounts can do, with nothing restricted

Since you're the one who set the clinic's policies in the first place, there's no onboarding or document-signing required on your account — you're taken straight in. The underlying policy documents (health & safety, infection control, complaints, data protection and our internal SOPs) remain available as downloadable PDFs from your Profile page whenever you want to review or update them.

Sign in any time at ${appUrl}.

— Radiant Booking`;
    return resend.emails.send({ from: FROM_EMAIL, to: [to], subject: 'Welcome to the Radiant Booking Platform', text: body });
  }

  if (userType === 'member') {
    const tierLabel = { access: 'Access Member', enhanced: 'Enhanced Member' }[directoryTier] || 'Access Member';
    const body = `Hi ${name},

Welcome to Radiant Membership! We're delighted to have you join us.

As a Radiant member, you get:
- A listing on our practitioner and member site, so clients can find and book with you
- Priority booking access ahead of general availability
- Invitations to member-only events and networking evenings
- A dedicated space to manage your bookings and profile

Your community membership: ${tierLabel}${directoryTier === 'access' ? '\n(Enhanced Membership adds a detailed profile page, logo and social links, plus the ability to message other members directly - ask Staff & Admin if you\'d like to upgrade.)' : ''}

Sign in any time at ${appUrl} to get started.

— Radiant Booking`;
    return resend.emails.send({ from: FROM_EMAIL, to: [to], subject: 'Welcome to Radiant Membership', text: body });
  }

  if (userType === 'practitioner') {
    const body = `Hi ${name},

Welcome to the Radiant Booking Platform — you're all set up as a Practitioner.

Here's how it works:
- Check live room availability before you book — no more double-bookings
- Book a room in a few taps, with instant confirmation by email
- Sync every booking straight to your Google Calendar
- Manage your professional profile, qualifications and indemnity details

One important step first: before you can book a room, you'll need to complete your onboarding — filling in your profile and reading and signing our clinical and operational documents. You'll be guided through this automatically the first time you sign in.${tierSectionFor(planTier)}

Sign in any time at ${appUrl} to get started.

— Radiant Booking`;
    return resend.emails.send({ from: FROM_EMAIL, to: [to], subject: 'Welcome to the Radiant Booking Platform', text: body });
  }

  if (userType === 'administrator') {
    const body = `Hi ${name},

Welcome to the Radiant Booking Platform — you're all set up as Staff & Admin.

Here's what you can do:
- Manage rooms, members and bookings across the whole clinic
- Send invitations and track onboarding for new practitioners and members
- Book treatment rooms in real time, with automatic clash-checking
- Sync bookings straight to your Google Calendar

One important step first: you'll need to complete a short onboarding — filling in your profile and reading and signing the clinic's operational and clinical policies (health & safety, infection control, complaints, data protection, and our internal Standard Operating Procedures for reception, bookings, payments and more). You'll be guided through this automatically the first time you sign in, and every signed document stays available as a downloadable PDF from your Profile page any time you need to check back.

Sign in any time at ${appUrl} to get started.

— Radiant Booking`;
    return resend.emails.send({ from: FROM_EMAIL, to: [to], subject: 'Welcome to the Radiant Booking Platform', text: body });
  }

  // Guest / fallback
  const body = `Hi ${name},

Welcome to the Radiant Booking Platform — you're all set up as a ${userType.charAt(0).toUpperCase() + userType.slice(1)}.

Here's what you can do:
- Book treatment rooms in real time, with automatic clash-checking
- Get instant email confirmations and reminders before every session
- Sync bookings straight to your Google Calendar

Sign in any time at ${appUrl} to get started.

— Radiant Booking`;
  return resend.emails.send({ from: FROM_EMAIL, to: [to], subject: 'Welcome to the Radiant Booking Platform', text: body });
}

async function sendRotaUpdate({ to, staffName, shiftDate, dayOfWeek, timeRange, status, removed, rangeText }) {
  const resend = getResend();
  const statusText = { scheduled: `working ${timeRange || ''}`, closed: 'closed', annual_leave: 'on annual leave', tbc: 'TBC' }[status] || status;
  const dateStr = rangeText || new Date(shiftDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const body = removed
    ? `Hi ${staffName},\n\nShifts on your rota have been removed: ${dateStr}.\n\n— Radiant Booking`
    : `Hi ${staffName},\n\nYour rota has been updated:\n\n${dateStr}${rangeText ? '' : ` — ${statusText}`}\n\n— Radiant Booking`;
  return resend.emails.send({ from: FROM_EMAIL, to: Array.isArray(to) ? to : [to], subject: `Rota update: ${dateStr}`, text: body });
}

async function sendLeaveUpdate({ to, staffName, leaveDate, code, removed, rangeText }) {
  const resend = getResend();
  const codeLabel = { AL: 'Annual Leave', BH: 'Bank Holiday', SICK: 'Sick Leave', OTHER: 'Leave' }[code] || code;
  const dateStr = rangeText || new Date(leaveDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const body = removed
    ? `Hi ${staffName},\n\nA leave entry has been removed from the calendar: ${dateStr} (${codeLabel}).\n\n— Radiant Booking`
    : `Hi ${staffName},\n\n${codeLabel} has been booked for you:\n\n${dateStr}\n\n— Radiant Booking`;
  return resend.emails.send({ from: FROM_EMAIL, to: Array.isArray(to) ? to : [to], subject: `${codeLabel} booked: ${dateStr}`, text: body });
}

async function sendLeaveApprovalRequest({ to, approverName, staffName, rangeText, code, approveUrl, declineUrl }) {
  const resend = getResend();
  const codeLabel = { AL: 'Annual Leave', BH: 'Bank Holiday', SICK: 'Sick Leave', OTHER: 'Leave' }[code] || code;
  const body = `Hi ${approverName || 'there'},

A ${codeLabel} request needs your approval:

${staffName} — ${rangeText}

Approve: ${approveUrl}
Decline: ${declineUrl}

You can also review this from the Staff Area in the Radiant Booking Platform.

— Radiant Booking`;
  return resend.emails.send({ from: FROM_EMAIL, to: [to], subject: `Approval needed: ${staffName} — ${codeLabel}`, text: body });
}

async function sendLeaveDecision({ to, staffName, leaveDate, code, approved, reason, rangeText }) {
  const resend = getResend();
  const codeLabel = { AL: 'Annual Leave', BH: 'Bank Holiday', SICK: 'Sick Leave', OTHER: 'Leave' }[code] || code;
  const dateStr = rangeText || new Date(leaveDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const body = approved
    ? `Hi ${staffName},\n\nYour ${codeLabel} request for ${dateStr} has been approved.\n\n— Radiant Booking`
    : `Hi ${staffName},\n\nYour ${codeLabel} request for ${dateStr} was not approved.${reason ? `\n\nReason: ${reason}` : ''}\n\n— Radiant Booking`;
  return resend.emails.send({ from: FROM_EMAIL, to: Array.isArray(to) ? to : [to], subject: `${codeLabel} request ${approved ? 'approved' : 'declined'}: ${dateStr}`, text: body });
}

async function sendExitNoticeReminder({ to, memberName, planTier, noticeDays, cycleEndDate, noticeDeadlineDate }) {
  const resend = getResend();
  const tierLabel = TIER_LABELS[planTier] || planTier;
  const cycleEndStr = new Date(cycleEndDate).toLocaleDateString('en-GB', { dateStyle: 'long' });
  const deadlineStr = new Date(noticeDeadlineDate).toLocaleDateString('en-GB', { dateStyle: 'long' });
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `Your ${tierLabel} membership term ends ${cycleEndStr} — notice period coming up`,
    text: `Hi ${memberName},\n\nYour current ${tierLabel} membership term ends on ${cycleEndStr}.\n\n${tierLabel} membership requires ${noticeDays} days' written notice to exit, which means the deadline to give notice if you don't wish to continue is ${deadlineStr}.\n\nIf you're happy to continue, there's nothing to do — your recurring slot carries on as normal. If you'd like to give notice, please contact Staff & Admin before ${deadlineStr}.\n\n— Radiant Booking`,
  });
}

// For the "Add User" (create now) path on the Members page — distinct from
// the token-based Invite flow, this account already exists and is already
// active; the link just lets them set their own password via the app's
// existing password-recovery UI (the same one behind "Forgot password?").
async function sendAccountCreatedEmail({ to, firstName, actionLink }) {
  const resend = getResend();
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: 'Your Radiant Booking account is ready',
    text: `Hi ${firstName},

An account has been set up for you on the Radiant Booking Platform.

Set your password to get started: ${actionLink}

Once you've set a password, you can sign in any time with your email address.

— Radiant Booking`,
  });
}

// For an admin helping someone who's already got an account but is stuck
// getting back in (forgotten password, etc.) — distinct from
// sendAccountCreatedEmail, which is for a brand new account. Reuses the
// exact same Supabase recovery-link mechanism as the person's own "Forgot
// Password" would, just triggered by an admin on their behalf instead of
// requiring them to do it themselves.
async function sendPasswordResetEmail({ to, firstName, actionLink }) {
  const resend = getResend();
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: 'Reset your Radiant Booking password',
    text: `Hi ${firstName},

Staff & Admin have sent you a link to reset your Radiant Booking password.

Set a new password: ${actionLink}

If you didn't need this, you can safely ignore it — your existing password stays unchanged unless you use the link above.

— Radiant Booking`,
  });
}

// Urgent in-app messages also send this — the point is reaching someone
// who isn't looking at the screen (smartwatch, phone in a pocket), which a
// bell chime alone can't do. Kept deliberately short and scannable since
// urgency means someone's reading it on a lock screen, not settling in.
async function sendUrgentMessageEmail({ to, recipientName, senderName, body, contextLabel }) {
  const resend = getResend();
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `🔔 Urgent from ${senderName}${contextLabel ? ` — ${contextLabel}` : ''}`,
    text: `Hi ${recipientName},

${senderName} sent you an urgent message${contextLabel ? ` (${contextLabel})` : ''}:

"${body}"

Reply in the Radiant Booking app.

— Radiant Booking`,
  });
}

// Sent when a practitioner invites their own patient to a booking (opt-in,
// separate from the practitioner's own confirmation) — the patient is an
// external third party, not a system user, so this is deliberately its
// own thing rather than reusing sendBookingConfirmation. Includes the
// practice address as a real Google Maps link (a stable search-query URL,
// no API key needed) and a calendar invite, matching the same quality bar
// as every other booking email tonight.
const PRACTICE_ADDRESS = '88 High Street, Heathfield, East Sussex, TN21 8JD';
const PRACTICE_MAPS_LINK = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(PRACTICE_ADDRESS)}`;

async function sendPatientInviteEmail({ to, patientName, practitionerName, roomName, start, end, notes, icsContent }) {
  const resend = getResend();
  const dateStr = new Date(start).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
  const endStr = new Date(end).toLocaleString('en-GB', { timeStyle: 'short' });
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `Your appointment with ${practitionerName} — Radiant`,
    text: `Hi ${patientName || 'there'},

You have an appointment with ${practitionerName} at Radiant:

${dateStr} – ${endStr}
${roomName ? `Room: ${roomName}\n` : ''}
${PRACTICE_ADDRESS}
Get directions: ${PRACTICE_MAPS_LINK}

When you arrive, someone will meet you at reception.
${notes ? `\nA note from ${practitionerName}:\n${notes}\n` : ''}
A calendar invite is attached — most email apps will show an "Add to calendar" option.

See you then!

— Radiant`,
    attachments: icsContent ? [{
      filename: 'appointment.ics',
      content: Buffer.from(icsContent).toString('base64'),
      contentType: 'text/calendar; charset=utf-8; method=REQUEST',
    }] : undefined,
  });
}

module.exports = {
  sendBookingConfirmation, sendTeamBookingNotice, sendCancellationAlert, sendReminder, sendInvite,
  sendWelcomeEmail, sendRotaUpdate, sendLeaveUpdate, sendLeaveApprovalRequest, sendLeaveDecision, sendExitNoticeReminder,
  sendMandateActiveEmail, sendSessionPaymentConfirmedEmail, sendSessionPaymentFailedEmail,
  sendSubscriptionStartedEmail, sendSubscriptionPaymentFailedEmail, sendAccountCreatedEmail, sendUrgentMessageEmail,
  sendPasswordResetEmail,
  sendPatientInviteEmail,
};
