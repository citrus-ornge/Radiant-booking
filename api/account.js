const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  let member, authUser;
  try {
    const auth = await requireAuth(req);
    member = auth.member;
    authUser = auth.authUser;
    if (!member) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  const supabase = getSupabase();

  // Deletes the member row. bookings.member_id and document_signatures.member_id
  // both cascade on delete, so those go too. Invites are keyed by email, not
  // member_id, so they're left as a historical record (no personal profile data).
  const { error: memberErr } = await supabase.from('members').delete().eq('id', member.id);
  if (memberErr) return res.status(500).json({ error: memberErr.message });

  // Also remove the actual Supabase Auth login - without this the person could
  // still sign in to a now-empty account.
  try {
    await supabase.auth.admin.deleteUser(authUser.id);
  } catch (e) {
    // Member data is already gone even if this part fails; log for follow-up.
    console.error('Failed to delete auth user after member deletion:', e.message);
  }

  res.status(200).json({ deleted: true });
};
