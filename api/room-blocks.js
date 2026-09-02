const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');

// Admin-only room holds — team review: "the ability for admin only to
// block out any slot anytime, whether it be a day, half day, hour, two
// hour, and it doesn't need to have the hour restriction... this is for
// admin the ability to just book timeout, and that could be for events...
// or rooms being under construction or being closed out." Genuinely
// separate from real bookings — no duration restriction, no 1-hour-topup
// rule, no payment, no member attached. Hard block: see
// isRoomBlockedForRange() in api/bookings.js, checked server-side before
// any real booking can be created — this endpoint being admin-only isn't
// itself what makes the block real; the check in bookings.js is.
module.exports = async (req, res) => {
  const supabase = getSupabase();
  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  if (req.method === 'GET') {
    // Team review: a hard block means members must be prevented from
    // booking over it — which means they need to know it exists, just
    // not necessarily why if is_private is set. Same reduced-detail
    // pattern already used for bookings.js: non-admins get only what's
    // needed to correctly show a time as unavailable (room, start, end),
    // never the reason or who created it, regardless of is_private —
    // admins get the full picture for their own management/calendar use.
    const isAdmin = requester.user_type === 'administrator';
    const { data, error } = await supabase
      .from('room_blocks')
      .select(isAdmin
        ? 'id, room_id, start_time, end_time, reason, is_private, created_at, room:rooms(id, name), created_by_member:members!room_blocks_created_by_fkey(first_name, last_name)'
        : 'id, room_id, start_time, end_time')
      .order('start_time', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ blocks: data });
  }

  if (req.method === 'POST') {
    if (requester.user_type !== 'administrator') return res.status(403).json({ error: 'Only Staff & Admin can block out a room' });
    const { room_id, start_time, end_time, reason, is_private } = req.body || {};
    if (!room_id || !start_time || !end_time) {
      return res.status(400).json({ error: 'room_id, start_time and end_time are required' });
    }
    if (new Date(end_time) <= new Date(start_time)) {
      return res.status(400).json({ error: 'end_time must be after start_time' });
    }
    const { data: block, error } = await supabase
      .from('room_blocks')
      .insert({ room_id, start_time, end_time, reason: reason || null, is_private: !!is_private, created_by: requester.id })
      .select('id, room_id, start_time, end_time, reason, is_private, created_at, room:rooms(id, name)')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    await logAudit({
      actorId: requester.id, actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
      action: 'room_block.created', entityType: 'room', entityId: room_id,
      details: { start_time, end_time, reason, is_private: !!is_private },
    });

    return res.status(200).json({ block });
  }

  if (req.method === 'DELETE') {
    if (requester.user_type !== 'administrator') return res.status(403).json({ error: 'Only Staff & Admin can remove a room block' });
    const blockId = req.query.id;
    if (!blockId) return res.status(400).json({ error: 'id is required' });
    const { error } = await supabase.from('room_blocks').delete().eq('id', blockId);
    if (error) return res.status(500).json({ error: error.message });

    await logAudit({
      actorId: requester.id, actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email,
      action: 'room_block.removed', entityType: 'room', entityId: blockId,
      details: {},
    });

    return res.status(204).end();
  }

  res.status(405).json({ error: 'Method not allowed' });
};
