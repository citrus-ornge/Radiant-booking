const { requireAuth } = require('./_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { authUser, member } = await requireAuth(req);
    if (!member) {
      return res.status(404).json({ error: 'No member record linked to this account yet', authEmail: authUser.email });
    }
    res.status(200).json({ member });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
