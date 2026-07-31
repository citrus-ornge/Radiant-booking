const { getSupabase } = require('../_lib/supabase');
const { approveLeaveBatch, declineLeaveBatch, fmtRange } = require('../_lib/leaveApproval');

function page(title, message, ok) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:Georgia,serif;background:#F7F1E8;color:#2B2B2B;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
.card{background:#fff;border-radius:16px;padding:40px 32px;max-width:420px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.08);}
h1{font-size:20px;margin:0 0 12px;color:${ok ? '#1F6F6B' : '#9B2C4A'};}
p{font-size:14px;line-height:1.6;color:#555;}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html');

  if (req.method !== 'GET') {
    return res.status(405).send(page('Method not allowed', 'Please use the link from your email.', false));
  }

  const { token, action } = req.query;
  if (!token || !['approve', 'decline'].includes(action)) {
    return res.status(400).send(page('Invalid link', 'This approval link looks incomplete. Please check the Staff Area in the app instead.', false));
  }

  const supabase = getSupabase();
  const { data: rows } = await supabase.from('leave_days').select('staff_name, leave_date, status').eq('approval_token', token);
  if (!rows || rows.length === 0) {
    return res.status(404).send(page('Link not found', 'This approval link is invalid or has already been used.', false));
  }
  if (rows[0].status !== 'pending') {
    return res.status(200).send(page('Already handled', `This request for ${rows[0].staff_name} has already been ${rows[0].status}.`, rows[0].status === 'approved'));
  }

  const rangeText = fmtRange(rows, 'leave_date');

  if (action === 'approve') {
    const result = await approveLeaveBatch(supabase, token, null);
    if (result.error) return res.status(400).send(page('Could not approve', result.error, false));
    return res.status(200).send(page('Request approved', `${rows[0].staff_name}'s leave — ${rangeText} — has been approved and synced to the calendar.`, true));
  } else {
    const result = await declineLeaveBatch(supabase, token, null, null);
    if (result.error) return res.status(400).send(page('Could not decline', result.error, false));
    return res.status(200).send(page('Request declined', `${rows[0].staff_name}'s leave request — ${rangeText} — has been declined. They've been notified.`, false));
  }
};
