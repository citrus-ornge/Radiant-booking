const { Resend } = require('resend');

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Missing RESEND_API_KEY env var');
  return new Resend(key);
}

// booking.radiantfr.com is now verified in Resend (as of 30 Jul 2026),
// so real emails can go to any address, not just the account owner's own.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Radiant Booking <booking@booking.radiantfr.com>';

async function sendBookingConfirmation({ to, memberName, roomName, start, end }) {
  const resend = getResend();
  const dateStr = new Date(start).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `Booking confirmed: ${roomName}`,
    text: `Hi ${memberName},\n\nYour booking for ${roomName} on ${dateStr} is confirmed.\n\n— Radiant Booking`,
  });
}

async function sendCancellationAlert({ to, roomName, start }) {
  const resend = getResend();
  const dateStr = new Date(start).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `Booking cancelled: ${roomName}`,
    text: `The booking for ${roomName} on ${dateStr} has been cancelled.\n\n— Radiant Booking`,
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

function tierSectionFor(userType, planTier) {
  if (userType !== 'practitioner' && userType !== 'member') return '';
  if (planTier && TIER_LABELS[planTier]) {
    return `\n\nYour membership tier: ${TIER_LABELS[planTier]}\nYou can view the full details of your membership any time from your Profile page.`;
  }
  return `\n\nMembership tier: not yet set\nYou can select your membership tier (Community, Flex, Core or Resident) from your Profile page.`;
}

async function sendWelcomeEmail({ to, firstName, userType, planTier, isOwner }) {
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
    const body = `Hi ${name},

Welcome to Radiant Membership! We're delighted to have you join us.

As a Radiant member, you get:
- A listing on our practitioner and member site, so clients can find and book with you
- Priority booking access ahead of general availability
- Invitations to member-only events and networking evenings
- A dedicated space to manage your bookings and profile

Your membership tier: ${planTier && TIER_LABELS[planTier] ? TIER_LABELS[planTier] : 'not yet set — you can choose this from your Profile page'}

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

One important step first: before you can book a room, you'll need to complete your onboarding — filling in your profile and reading and signing our clinical and operational documents. You'll be guided through this automatically the first time you sign in.${tierSectionFor(userType, planTier)}

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
  return resend.emails.send({ from: FROM_EMAIL, to: [to], subject: `Rota update: ${dateStr}`, text: body });
}

async function sendLeaveUpdate({ to, staffName, leaveDate, code, removed, rangeText }) {
  const resend = getResend();
  const codeLabel = { AL: 'Annual Leave', BH: 'Bank Holiday', SICK: 'Sick Leave', OTHER: 'Leave' }[code] || code;
  const dateStr = rangeText || new Date(leaveDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const body = removed
    ? `Hi ${staffName},\n\nA leave entry has been removed from the calendar: ${dateStr} (${codeLabel}).\n\n— Radiant Booking`
    : `Hi ${staffName},\n\n${codeLabel} has been booked for you:\n\n${dateStr}\n\n— Radiant Booking`;
  return resend.emails.send({ from: FROM_EMAIL, to: [to], subject: `${codeLabel} booked: ${dateStr}`, text: body });
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
  return resend.emails.send({ from: FROM_EMAIL, to: [to], subject: `${codeLabel} request ${approved ? 'approved' : 'declined'}: ${dateStr}`, text: body });
}

module.exports = { sendBookingConfirmation, sendCancellationAlert, sendReminder, sendInvite, sendWelcomeEmail, sendRotaUpdate, sendLeaveUpdate, sendLeaveApprovalRequest, sendLeaveDecision };
