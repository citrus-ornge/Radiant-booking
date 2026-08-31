// Resolves {{token}} placeholders and {{#if token}}...{{/if}} conditional
// blocks in a document's content against a specific member's real data.
// Used both when a member reads a document (GET /api/documents — so what
// they see already has their real name/tier/etc filled in) and when they
// sign one (POST /api/documents — so document_signatures.content_snapshot,
// the permanent historical record, stores what they actually agreed to,
// not a template still full of {{tokens}}).
//
// Built for the Practitioner Membership Agreement (team review 19 Aug
// 2026 — Rosie's real document, replacing the placeholder), but works for
// any document that happens to use these tokens; one with none of them is
// returned unchanged.
const TIER_LABELS = { community: 'Community', flex: 'Flex', core: 'Core', resident: 'Resident' };

function resolveDocumentContent(content, member) {
  if (!content || content.indexOf('{{') === -1) return content;

  const roomType = (() => {
    const slots = member.recurring_slots || [];
    if (slots.length === 0) return null;
    const names = [...new Set(slots.map(s => s.room && s.room.name).filter(Boolean))];
    return names.length ? names.join(' & ') : null;
  })();

  const tokens = {
    practitioner_name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || null,
    business_name: member.business_name || null,
    company_address: member.company_address || null,
    company_number: member.company_number || null,
    membership_tier: TIER_LABELS[member.plan_tier] || null,
    room_type: roomType,
    // Resolved live at read/sign time rather than stored anywhere — for a
    // membership agreement, "start date" means the date it's actually
    // being agreed, which for both read and sign happens in the same
    // sitting in practice.
    agreement_start_date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }),
  };

  let result = content;
  // Conditional blocks first — {{#if token}}...{{/if}} is kept (minus the
  // markers) only when that token has a real value, so an optional field
  // like company_number just disappears (including its line) rather than
  // showing "Company Registration Number: " with nothing after it.
  result = result.replace(/{{#if (\w+)}}([\s\S]*?){{\/if}}/g, (_, key, inner) => (tokens[key] ? inner : ''));
  // Plain substitution. Falls back to '' rather than leaving a raw
  // {{token}} visible if something unexpected is unresolved.
  result = result.replace(/{{(\w+)}}/g, (_, key) => (tokens[key] != null ? tokens[key] : ''));
  return result;
}

module.exports = { resolveDocumentContent };
