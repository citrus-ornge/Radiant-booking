const { createClient } = require('@supabase/supabase-js');

// Uses the service_role key so functions can bypass RLS — this file
// only ever runs server-side inside Vercel functions, never shipped
// to the browser.
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

module.exports = { getSupabase };
