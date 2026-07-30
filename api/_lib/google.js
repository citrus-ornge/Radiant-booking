const { google } = require('googleapis');

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI; // e.g. https://radiant-booking.vercel.app/api/auth/google/callback
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI env vars');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

function getAuthUrl(state) {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline', // required to get a refresh_token
    prompt: 'consent',      // forces refresh_token on repeat sign-ins too
    scope: SCOPES,
    state,
  });
}

async function exchangeCodeForTokens(code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, ... }
}

async function createCalendarEvent({ refreshToken, summary, description, startISO, endISO, allDay, startDate, endDate }) {
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const calendar = google.calendar({ version: 'v3', auth: client });
  const requestBody = { summary, description };
  if (allDay) {
    requestBody.start = { date: startDate };
    requestBody.end = { date: endDate };
  } else {
    requestBody.start = { dateTime: startISO };
    requestBody.end = { dateTime: endISO };
  }
  const res = await calendar.events.insert({ calendarId: 'primary', requestBody });
  return res.data; // includes .id (google_event_id) and .htmlLink
}

async function deleteCalendarEvent({ refreshToken, eventId }) {
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const calendar = google.calendar({ version: 'v3', auth: client });
  await calendar.events.delete({ calendarId: 'primary', eventId });
}

module.exports = { getAuthUrl, exchangeCodeForTokens, createCalendarEvent, deleteCalendarEvent };
