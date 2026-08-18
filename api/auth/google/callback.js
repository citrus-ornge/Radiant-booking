const { exchangeCodeForTokens } = require('../../_lib/google');
const { getSupabase } = require('../../_lib/supabase');

module.exports = async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const baseUrl = process.env.PUBLIC_APP_URL || 'https://booking.radiantfr.com';

  if (oauthError) {
    res.writeHead(302, { Location: `${baseUrl}/?calendar=error&reason=${encodeURIComponent(oauthError)}` });
    return res.end();
  }
  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state from Google' });
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Happens if the user has already granted consent before and Google
      // doesn't re-issue a refresh_token. They need to revoke access at
      // https://myaccount.google.com/permissions and try again.
      res.writeHead(302, { Location: `${baseUrl}/?calendar=error&reason=no_refresh_token` });
      return res.end();
    }

    const supabase = getSupabase();
    const { error } = await supabase
      .from('members')
      .update({ google_calendar_connected: true, google_refresh_token: tokens.refresh_token })
      .eq('id', state);
    if (error) throw error;

    res.writeHead(302, { Location: `${baseUrl}/?calendar=connected` });
    res.end();
  } catch (e) {
    res.writeHead(302, { Location: `${baseUrl}/?calendar=error&reason=${encodeURIComponent(e.message)}` });
    res.end();
  }
};
