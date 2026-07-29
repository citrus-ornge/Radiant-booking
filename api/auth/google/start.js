const { getAuthUrl } = require('../../_lib/google');

module.exports = async (req, res) => {
  const { member_id } = req.query;
  if (!member_id) return res.status(400).json({ error: 'member_id query param is required' });

  // state carries the member_id through the OAuth round-trip so the
  // callback knows whose refresh token this is.
  const url = getAuthUrl(member_id);
  res.writeHead(302, { Location: url });
  res.end();
};
