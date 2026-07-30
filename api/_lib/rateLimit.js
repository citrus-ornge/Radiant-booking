const { getSupabase } = require('./supabase');

// Returns true if the request is allowed, false if the caller has exceeded
// maxRequests within windowSeconds for this key. Records the hit if allowed.
// `key` should uniquely identify who/what is being limited, e.g.
// `invite_create:${adminId}` or `booking_create:${memberId}`.
async function checkRateLimit(key, maxRequests, windowSeconds) {
  const supabase = getSupabase();
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();

  const { count, error } = await supabase
    .from('rate_limit_hits')
    .select('id', { count: 'exact', head: true })
    .eq('key', key)
    .gte('created_at', since);

  if (error) {
    // Fail open rather than blocking legitimate traffic over a logging issue,
    // but this is logged so it's visible in Vercel function logs.
    console.error('Rate limit check failed:', error.message);
    return true;
  }

  if ((count || 0) >= maxRequests) return false;

  await supabase.from('rate_limit_hits').insert({ key });
  return true;
}

module.exports = { checkRateLimit };
