// Generates RFC5545-compliant .ics calendar invites for booking emails.
// This is the universal path — works in Gmail, Outlook, Apple Mail, etc.
// with zero setup from the recipient, unlike the Google Calendar OAuth
// direct-sync (_lib/google.js), which only works for members who've
// explicitly connected their Google account. Both run side by side: this
// is the baseline everyone gets, OAuth sync is a bonus for those who want
// the event to appear without touching the email at all.

// Per RFC5545, lines must be CRLF-terminated and folded at 75 octets.
// Long fields (mainly DESCRIPTION) can otherwise break stricter parsers.
function foldLine(line) {
  if (line.length <= 75) return line;
  let result = '';
  let rest = line;
  while (rest.length > 75) {
    result += rest.slice(0, 75) + '\r\n ';
    rest = rest.slice(75);
  }
  return result + rest;
}

// Escapes TEXT property values per RFC5545 (backslash, semicolon, comma,
// newline) — required or a comma/semicolon in a room name or note could
// corrupt the file structure.
function escapeText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function toIcsDate(isoString) {
  return new Date(isoString).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// method: 'REQUEST' for a new/updated booking, 'CANCEL' for a cancellation.
// uid must be the SAME value across create and cancel for the same booking
// — that's what lets a calendar app match the cancellation to the
// original event and remove/update it, rather than creating a stray entry.
function generateBookingIcs({ uid, summary, description, location, startISO, endISO, sequence, method }) {
  const now = toIcsDate(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Radiant Booking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${toIcsDate(startISO)}`,
    `DTEND:${toIcsDate(endISO)}`,
    `SUMMARY:${escapeText(summary)}`,
    description ? `DESCRIPTION:${escapeText(description)}` : null,
    location ? `LOCATION:${escapeText(location)}` : null,
    `SEQUENCE:${sequence || 0}`,
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// A stable UID for a booking, so create and cancel emails reference the
// same calendar entry. Not a real email domain — just needs to be globally
// unique and consistent, which booking.id already guarantees.
function bookingIcsUid(bookingId) {
  return `booking-${bookingId}@booking.radiantfr.com`;
}

module.exports = { generateBookingIcs, bookingIcsUid };
