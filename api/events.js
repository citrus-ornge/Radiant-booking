const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');

module.exports = async (req, res) => {
  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  const supabase = getSupabase();

  if (req.method === 'GET') {
    // Visible to any signed-in member/practitioner/staff
    const { data, error } = await supabase.from('events').select('*').order('start_time', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ events: data });
  }

  if (req.method === 'POST') {
    if (requester.user_type !== 'administrator') {
      return res.status(403).json({ error: 'Only Staff & Admin can create events' });
    }
    const { title, description, start_time, end_time, location } = req.body || {};
    if (!title || !start_time) return res.status(400).json({ error: 'title and start_time are required' });

    const { data, error } = await supabase
      .from('events')
      .insert({ title, description, start_time, end_time: end_time || null, location, created_by: requester.id })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    logAudit({
      actorId: requester.id, actorName: `${requester.first_name} ${requester.last_name}`.trim(),
      action: 'event.created', entityType: 'event', entityId: data.id, details: { title },
    });

    return res.status(201).json({ event: data });
  }

  if (req.method === 'PATCH') {
    if (requester.user_type !== 'administrator') {
      return res.status(403).json({ error: 'Only Staff & Admin can edit events' });
    }
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const allowed = ['title', 'description', 'start_time', 'end_time', 'location'];
    const updates = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) updates[key] = fields[key];
    }
    const { data, error } = await supabase.from('events').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ event: data });
  }

  if (req.method === 'DELETE') {
    if (requester.user_type !== 'administrator') {
      return res.status(403).json({ error: 'Only Staff & Admin can remove events' });
    }
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { error } = await supabase.from('events').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    logAudit({
      actorId: requester.id, actorName: `${requester.first_name} ${requester.last_name}`.trim(),
      action: 'event.deleted', entityType: 'event', entityId: id,
    });

    return res.status(200).json({ deleted: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
