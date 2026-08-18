const { getSupabase } = require('./_lib/supabase');
const { checkRateLimit } = require('./_lib/rateLimit');
const { sendPasswordResetEmail } = require('./_lib/email');

// POST /api/request-password-reset { email }
// No auth required — this IS the "I'm locked out" path. Self-service
// counterpart to members-reset-password.js (which is the admin-triggered
// version) — same underlying mechanism, same branded email, just callable
// by the person themselves rather than requiring an admin to do it for
// them.
//
// Replaces the previous approach of calling Supabase's own
// auth.resetPasswordForEmail() directly from the browser, which sends
// Supabase's default unbranded email ("Supabase Auth
// <noreply@mail.app.supabase.io>") — jarring next to every other email
// this app sends, which is branded and comes from Radiant.
//
// Deliberately always returns the same generic response whether or not an
// account exists for the given email (never confirms/denies) — this is
// what actually enforces "you must be invited first" without turning it
// into an email-enumeration oracle. Rate-limited by email so this can't be
// used to spam someone's inbox.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });

  const genericResponse = { message: 'If an account exists for that email, a reset link is on its way.' };

  const allowed = await checkRateLimit(`password_reset:${email.toLowerCase()}`, 3, 3600);
  if (!allowed) return res.status(200).json(genericResponse); // still generic — don't reveal rate limiting either

  const supabase = getSupabase();
  try {
    const { data: member } = await supabase.from('members').select('id, first_name, email, auth_user_id').eq('email', email).maybeSingle();
    if (member && member.auth_user_id) {
      const baseUrl = process.env.PUBLIC_APP_URL || 'https://radiant-booking.vercel.app';
      const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
        type: 'recovery', email: member.email, options: { redirectTo: baseUrl },
      });
      if (!linkErr) {
        await sendPasswordResetEmail({ to: member.email, firstName: member.first_name || 'there', actionLink: linkData.properties.action_link });
      } else {
        console.error(`Failed to generate recovery link for ${email}:`, linkErr.message);
      }
    }
    // No matching member, or no auth_user_id (never actually had an
    // account) — silently do nothing. Still returns the same response below.
  } catch (e) {
    console.error(`Password reset request failed for ${email}:`, e.message);
    // Still return the generic success response — an internal error here
    // shouldn't tell an attacker anything either.
  }

  return res.status(200).json(genericResponse);
};
