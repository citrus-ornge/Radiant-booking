const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');

// Extracted so api/view-as.js (admin "View As" mode) can attach the exact
// same computed fields for an arbitrary target member, rather than
// duplicating this logic — keeps both endpoints describing a member
// identically, whichever one is used to fetch them.
async function attachComputedMemberFields(member) {
  if (['core', 'resident'].includes(member.plan_tier)) {
    const supabase = getSupabase();
    const { data: slots } = await supabase
      .from('member_recurring_slots')
      .select('id, day_of_week, time_start, time_end, room_id, interval_weeks, anchor_date, starts_from, room:rooms(id, name)')
      .eq('member_id', member.id)
      .order('day_of_week');
    member.recurring_slots = slots || [];
  } else {
    member.recurring_slots = [];
  }

  if (member.user_type === 'practitioner') {
    const supabase = getSupabase();
    const { data: docs } = await supabase
      .from('member_documents')
      .select('document_type')
      .eq('member_id', member.id)
      .in('document_type', ['id_proof', 'insurance']);
    const types = new Set((docs || []).map(d => d.document_type));
    member.missing_mandatory_compliance_docs = !(types.has('id_proof') && types.has('insurance'));
  } else {
    member.missing_mandatory_compliance_docs = false;
  }
  return member;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { authUser, member } = await requireAuth(req);
    if (!member) {
      return res.status(404).json({ error: 'No member record linked to this account yet', authEmail: authUser.email });
    }
    // Attach recurring slots directly so the frontend never has to make a
    // second call just to know a Core/Resident member's agreed day(s) —
    // they can have more than one (e.g. full day Monday + half day Friday).
    await attachComputedMemberFields(member);
    res.status(200).json({ member });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
module.exports.attachComputedMemberFields = attachComputedMemberFields;

