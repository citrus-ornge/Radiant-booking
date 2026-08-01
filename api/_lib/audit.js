const { getSupabase } = require('./supabase');

// Fire-and-forget audit logging - never throws, never blocks the calling
// request even if the write fails.
async function logAudit({ actorId, actorName, action, entityType, entityId, details }) {
  try {
    const supabase = getSupabase();
    await supabase.from('audit_log').insert({
      actor_id: actorId || null,
      actor_name: actorName || null,
      action,
      entity_type: entityType,
      entity_id: entityId ? String(entityId) : null,
      details: details || null,
    });
  } catch (e) {
    console.error('Audit log write failed:', e.message);
  }
}

module.exports = { logAudit };
