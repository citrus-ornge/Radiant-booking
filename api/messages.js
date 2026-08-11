const { getSupabase } = require('./_lib/supabase');
const { requireAuth } = require('./_lib/auth');
const { checkRateLimit } = require('./_lib/rateLimit');
const { sendUrgentMessageEmail } = require('./_lib/email');

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
    if (req.query.with) {
      // Full thread with one other person
      const otherId = req.query.with;
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .or(`and(sender_id.eq.${requester.id},recipient_id.eq.${otherId}),and(sender_id.eq.${otherId},recipient_id.eq.${requester.id})`)
        .order('created_at', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });

      // Mark their messages to me as read
      const unreadIds = data.filter(m => m.recipient_id === requester.id && !m.read_at).map(m => m.id);
      if (unreadIds.length > 0) {
        await supabase.from('messages').update({ read_at: new Date().toISOString() }).in('id', unreadIds);
      }

      return res.status(200).json({ messages: data });
    }

    // Conversation list: most recent message with each person I've exchanged with
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .or(`sender_id.eq.${requester.id},recipient_id.eq.${requester.id}`)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const byPerson = {};
    for (const m of data) {
      const otherId = m.sender_id === requester.id ? m.recipient_id : m.sender_id;
      if (!byPerson[otherId]) {
        byPerson[otherId] = { other_id: otherId, last_message: m.body, last_at: m.created_at, unread: 0 };
      }
      if (m.recipient_id === requester.id && !m.read_at) byPerson[otherId].unread++;
    }
    return res.status(200).json({ conversations: Object.values(byPerson) });
  }

  if (req.method === 'POST') {
    const allowed = await checkRateLimit(`message_send:${requester.id}`, 60, 3600);
    if (!allowed) return res.status(429).json({ error: 'Too many messages sent recently. Please wait a while.' });

    const { recipient_id, body, urgent, context_label } = req.body || {};
    if (!recipient_id || !body || !body.trim()) {
      return res.status(400).json({ error: 'recipient_id and body are required' });
    }
    if (recipient_id === requester.id) {
      return res.status(400).json({ error: "You can't message yourself" });
    }
    const { data: recipient } = await supabase.from('members').select('id, first_name, last_name, email, user_type').eq('id', recipient_id).maybeSingle();
    if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

    if (requester.user_type === 'member' && recipient.user_type === 'member' && requester.directory_tier !== 'enhanced') {
      return res.status(403).json({ error: 'Messaging other members is an Enhanced Member feature. Upgrade your membership to unlock it.' });
    }

    const { data, error } = await supabase
      .from('messages')
      .insert({ sender_id: requester.id, recipient_id, body: body.trim(), urgent: !!urgent })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // Urgent messages also send a real email — the point is reaching
    // someone who isn't looking at the screen (smartwatch, phone in a
    // pocket), which the in-app chime alone can't do. Never blocks the
    // response on this; the message itself has already sent successfully
    // either way.
    let urgent_email_sent = false;
    if (urgent && recipient.email) {
      try {
        const senderName = `${requester.first_name || ''} ${requester.last_name || ''}`.trim() || requester.email;
        const recipientName = recipient.first_name || 'there';
        await sendUrgentMessageEmail({ to: recipient.email, recipientName, senderName, body: body.trim(), contextLabel: context_label || null });
        urgent_email_sent = true;
      } catch (e) {
        console.error(`Failed to send urgent message email to ${recipient.email}:`, e.message);
      }
    }

    return res.status(201).json({ message: data, urgent_email_sent });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
