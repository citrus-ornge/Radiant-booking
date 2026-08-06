const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('rooms').select('*').order('name');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ rooms: data });
  }

  if (req.method === 'POST') {
    let requester;
    try {
      const auth = await requireAuth(req);
      requester = auth.member;
      if (!requester || requester.user_type !== 'administrator') {
        return res.status(403).json({ error: 'Only administrators can add rooms' });
      }
    } catch (e) {
      return res.status(e.status || 401).json({ error: e.message });
    }

    const { name, capacity, floor, accessible_to, notes, min_duration_minutes, max_duration_minutes, blackout_dates, pricing_category } = req.body || {};
    if (!name || !capacity) return res.status(400).json({ error: 'name and capacity are required' });

    const { data, error } = await supabase
      .from('rooms')
      .insert({
        name, capacity, floor, accessible_to: accessible_to || 'all', notes,
        min_duration_minutes: min_duration_minutes || null,
        max_duration_minutes: max_duration_minutes || null,
        blackout_dates: blackout_dates || [],
        pricing_category: pricing_category || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    logAudit({
      actorId: requester.id, actorName: `${requester.first_name} ${requester.last_name}`.trim(),
      action: 'room.created', entityType: 'room', entityId: data.id, details: { name },
    });

    return res.status(201).json({ room: data });
  }

  if (req.method === 'PATCH') {
    let requester;
    try {
      const auth = await requireAuth(req);
      requester = auth.member;
      if (!requester || requester.user_type !== 'administrator') {
        return res.status(403).json({ error: 'Only administrators can edit rooms' });
      }
    } catch (e) {
      return res.status(e.status || 401).json({ error: e.message });
    }

    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const allowed = ['name', 'capacity', 'floor', 'accessible_to', 'notes', 'min_duration_minutes', 'max_duration_minutes', 'blackout_dates', 'pricing_category'];
    const updates = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) updates[key] = fields[key];
    }

    const { data, error } = await supabase.from('rooms').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });

    logAudit({
      actorId: requester.id, actorName: `${requester.first_name} ${requester.last_name}`.trim(),
      action: 'room.updated', entityType: 'room', entityId: id, details: { fields: Object.keys(updates) },
    });

    return res.status(200).json({ room: data });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
