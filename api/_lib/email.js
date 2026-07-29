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

module.exports = { sendBookingConfirmation, sendCancellationAlert, sendReminder, sendInvite };
