const { getSupabase } = require('./supabase');

// Checks the single-row notification_settings table before sending a given
// class of email (booking_confirmation, reminder_24h, reminder_1h,
// cancellation_alert). Defaults to enabled if the row or field is missing,
// so a DB hiccup never silently swallows a notification.
async function isNotificationEnabled(key) {
  try {
    const supabase = getSupabase();
    const { data } = await supabase.from('notification_settings').select(key).eq('id', 1).maybeSingle();
    if (!data || !(key in data)) return true;
    return !!data[key];
  } catch (e) {
    return true;
  }
}

module.exports = { isNotificationEnabled };
