const { createClient } = require('@supabase/supabase-js');
const { getSupabase } = require('./supabase');

// Verifies the bearer token from the Authorization header against Supabase
// Auth, then resolves the members row linked to that auth user.
// Returns { authUser, member } or throws.
// These are PUBLIC by design (Supabase's anon/publishable key is meant to be
// embedded in client-side code) so hardcoding here (and in the browser JS)
// is intentional — not a leaked secret. The service_role key stays env-only.
const SUPABASE_URL = 'https://lygzlpeslpwptjqxtjgs.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_zHXuiXcq7UGXRDeTtMAfgA_NVTwpsSA';

async function requireAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    const err = new Error('Missing Authorization bearer token');
    err.status = 401;
    throw err;
  }

  // A client scoped to this specific user's token, purely to validate it
  // and read auth.users — not used for any privileged database access.
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data || !data.user) {
    const err = new Error('Invalid or expired session');
    err.status = 401;
    throw err;
  }
  const authUser = data.user;

  const supabase = getSupabase();
  const { data: member, error: memberErr } = await supabase
    .from('members')
    .select('*')
    .eq('auth_user_id', authUser.id)
    .maybeSingle();
  if (memberErr) {
    const err = new Error(memberErr.message);
    err.status = 500;
    throw err;
  }

  return { authUser, member };
}

module.exports = { requireAuth };
