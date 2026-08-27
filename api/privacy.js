// Standalone, directly-linkable Privacy Policy page — needed for Google's
// OAuth verification (moving Calendar sync from Testing to Production
// requires a real URL for this, not just the in-app modal, which Google's
// review process can't navigate to). A serverless function rather than a
// static HTML file specifically to guarantee it's reachable regardless of
// vercel.json's catch-all SPA rewrite (source: "/(.*)" -> "/index.html") —
// /api/* routes go straight to Functions, exactly like every other
// endpoint in this app, with zero ambiguity about routing precedence.
//
// Content mirrors the in-app modal exactly (index.html, privacy-policy-
// modal) — keep both in sync if either changes. Two placeholders below
// (data retention period, contact email) still need real values from the
// team before this is genuinely ready to submit to Google — see the
// visible draft notice.
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Privacy Policy — Radiant Booking Platform</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600&family=Montserrat:ital,wght@0,300;0,400;0,500;0,600&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Montserrat', sans-serif; background: #FAFAF5; color: #1A1A1A; font-size: 15px; line-height: 1.7; }
.wrap { max-width: 680px; margin: 0 auto; padding: 48px 24px 80px; }
.logo { font-family: 'Playfair Display', serif; font-size: 26px; color: #B5A078; margin-bottom: 28px; }
.draft-notice { background: #F3F0EA; border-radius: 8px; padding: 14px 16px; margin-bottom: 24px; font-size: 13px; color: #8C857B; }
.updated { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #8C857B; margin-bottom: 10px; }
h1 { font-family: 'Playfair Display', serif; font-size: 26px; font-weight: 500; margin-bottom: 8px; }
h2 { font-family: 'Playfair Display', serif; font-size: 17px; font-weight: 500; margin: 26px 0 8px; }
p { margin-bottom: 4px; }
a { color: #8A7550; }
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">Radiant</div>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: 30 July 2026</p>

  <div class="draft-notice">
    <strong>Draft for review.</strong> This is a working template pending confirmation from Radiant's team — data retention periods and the contact details below are placeholders and should be confirmed before this is submitted as the final version for Google OAuth verification.
  </div>

  <h2>Who we are</h2>
  <p>Radiant Medical Aesthetics ("Radiant", "we", "us") operates this booking platform for the use of our practitioners, members and staff. Radiant is the data controller for the personal data processed here.</p>

  <h2>What we collect</h2>
  <p>Account details (name, email, phone), professional details for practitioners (qualifications, indemnity insurance number and expiry), booking records (room, date, time, notes), and — only if you choose to connect it — a link to your Google Calendar for syncing bookings.</p>

  <h2>Why we process it</h2>
  <p>To operate the booking platform and manage room availability (performance of a contract with you), to verify practitioner credentials where legally required (legal obligation), and to keep the platform secure and prevent misuse (legitimate interest).</p>

  <h2>Who we share it with</h2>
  <p>We use the following processors to run this platform: Supabase (database and sign-in), Resend (sending booking and account emails), Google (calendar sync, only for accounts that connect it), and Vercel (hosting). None of these providers use your data for their own purposes.</p>

  <h2>Google Calendar access, specifically</h2>
  <p>If you connect Google Calendar, Radiant requests only the <code>calendar.events</code> scope — permission to create, update and remove calendar events for your own bookings. We never read, modify or share any other calendar data, and disconnecting at any time (My Profile → Calendar) immediately revokes this access.</p>

  <h2>How long we keep it</h2>
  <p><em>[TBC — placeholder pending confirmation]</em> We intend to retain your account data for as long as your account is active, and for a limited period afterwards where needed for legitimate business or legal purposes (for example, professional indemnity records required for compliance). When you delete your account, your profile and bookings are removed immediately; any retention beyond that for compliance reasons will be clearly explained separately.</p>

  <h2>Your rights</h2>
  <p>You can access, download or delete your personal data at any time from your Profile page ("Download my data" and "Delete my account"). You also have the right to ask us to correct inaccurate data, object to certain processing, or complain to the UK Information Commissioner's Office (ico.org.uk) if you believe your data has been mishandled.</p>

  <h2>Contact</h2>
  <p><em>[TBC — placeholder]</em> For any questions about this policy or your data, contact Radiant at <em>[privacy contact email to be confirmed]</em>.</p>
</div>
</body>
</html>`);
};
