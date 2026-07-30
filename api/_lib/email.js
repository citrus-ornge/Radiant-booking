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

async function sendInvite({ to, userType, note, inviteUrl }) {
  const resend = getResend();
  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `You're invited to Radiant Booking`,
    text: `You've been invited to join Radiant Booking as a ${userType}.\n${note ? `\nNote: ${note}\n` : ''}\nAccept here: ${inviteUrl}\n\nThis invite expires in 7 days.`,
  });
}

const TIER_LABELS = { community: 'Community', flex: 'Flex', core: 'Core', resident: 'Resident' };

function baseFeaturesFor(userType) {
  const shared = [
    '- Book treatment rooms in real time, with automatic clash-checking',
    '- Get instant email confirmations and reminders before every session',
    '- Sync bookings straight to your Google Calendar',
  ];
  if (userType === 'practitioner') {
    return [
      ...shared,
      '- Manage your professional profile, qualifications and indemnity details',
      '- See your upcoming sessions and booking history at a glance',
    ];
  }
  if (userType === 'administrator') {
    return [
      ...shared,
      '- Manage rooms, members and bookings across the whole clinic',
      '- Send invitations and track onboarding for new practitioners',
    ];
  }
  return shared;
}

async function sendWelcomeEmail({ to, firstName, userType, planTier }) {
  const resend = getResend();
  const roleLabel = userType.charAt(0).toUpperCase() + userType.slice(1);
  const features = baseFeaturesFor(userType).join('\n');

  let tierSection = '';
  if (userType === 'practitioner') {
    if (planTier && TIER_LABELS[planTier]) {
      tierSection = `\n\nYour membership tier: ${TIER_LABELS[planTier]}\nYour tier determines your room booking priority and access. You can view the full details of your membership any time from your Profile page.`;
    } else {
      tierSection = `\n\nMembership tier: not yet set\nYou can select your membership tier (Community, Flex, Core or Resident) from your Profile page — this determines your room booking priority and access.`;
    }
  }

  return resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: 'Welcome to the Radiant Booking Platform',
    text: `Hi ${firstName || 'there'},\n\nWelcome to the Radiant Booking Platform — you're all set up as a ${roleLabel}.\n\nHere's what you can do:\n${features}${tierSection}\n\nSign in any time at ${process.env.PUBLIC_APP_URL || 'https://radiant-booking.vercel.app'} to get started.\n\n— Radiant Booking`,
  });
}

module.exports = { sendBookingConfirmation, sendCancellationAlert, sendReminder, sendInvite, sendWelcomeEmail };
