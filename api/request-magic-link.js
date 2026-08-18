const { getSupabase } = require('./_lib/supabase');
const { checkRateLimit } = require('./_lib/rateLimit');
const { sendMagicLinkEmail } = require('./_lib/email');

// POST /api/request-magic-link { email }
// No auth required. Self-service counterpart to request-password-reset.js
// — same fix, different Supabase auth method. Found from real usage:
// "Sign in with a magic link instead" was calling Supabase's own
// auth.signInWithOtp() directly from the browser, which sends Supabase's
// default unbranded email ("Supabase Auth <noreply@mail.app.supabase.io>").
//
// Preserves the exact security property the original call had via
// shouldCreateUser: false — only ever sends a link for an email that
// already has a real account; never creates one. Same generic response
// regardless of whether the account exists, and rate-limited.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });

  const genericResponse = { message: 'If an account exists for that email, a sign-in link is on its way.' };

  const allowed = await checkRateLimit(`magic_link:${email.toLowerCase()}`, 3, 3600);
  if (!allowed) return res.status(200).json(genericResponse);

  const supabase = getSupabase();
  try {
    const { data: member } = await supabase.from('members').select('id, first_name, email, auth_user_id').eq('email', email).maybeSingle();
    if (member && member.auth_user_id) {
      const baseUrl = process.env.PUBLIC_APP_URL || 'https://booking.radiantfr.com';
      const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
        type: 'magiclink', email: member.email, options: { redirectTo: baseUrl },
      });
      if (!linkErr) {
        await sendMagicLinkEmail({ to: member.email, firstName: member.first_name || 'there', actionLink: linkData.properties.action_link });
      } else {
        console.error(`Failed to generate magic link for ${email}:`, linkErr.message);
      }
    }
    // No matching member, or no auth_user_id — silently do nothing,
    // same as request-password-reset.js. Never reveals which case it was.
  } catch (e) {
    console.error(`Magic link request failed for ${email}:`, e.message);
  }

  return res.status(200).json(genericResponse);
};
