const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { logAudit } = require('./_lib/audit');

const EDITABLE_FIELDS = ['booking_confirmation', 'reminder_24h', 'reminder_1h', 'cancellation_alert'];

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('notification_settings').select('*').eq('id', 1).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ settings: data || { booking_confirmation: true, reminder_24h: true, reminder_1h: true, cancellation_alert: true } });
  }

  if (req.method === 'PATCH') {
    let requester;
    try {
      const auth = await requireAuth(req);
      requester = auth.member;
      if (!requester || requester.user_type !== 'administrator') {
        return res.status(403).json({ error: 'Only administrators can change notification settings' });
      }
    } catch (e) {
      return res.status(e.status || 401).json({ error: e.message });
    }

    const updates = {};
    for (const key of EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) updates[key] = !!req.body[key];
    }

    const { data, error } = await supabase.from('notification_settings').update(updates).eq('id', 1).select().single();
    if (error) return res.status(500).json({ error: error.message });

    logAudit({
      actorId: requester.id, actorName: `${requester.first_name} ${requester.last_name}`.trim(),
      action: 'notification_settings.updated', entityType: 'notification_settings', entityId: '1',
      details: { fields: Object.keys(updates) },
    });

    return res.status(200).json({ settings: data });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
