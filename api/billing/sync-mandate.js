const { getSupabase } = require('../_lib/supabase');
const { requireAuth } = require('../_lib/auth');
const { logAudit } = require('../_lib/audit');

// POST /api/billing/sync-mandate { member_id }
//
// Admin-only. Reconciles a member's mandate_status directly against
// GoCardless, bypassing the webhook entirely.
//
// Built after finding every mandate ever attempted across a month of
// testing (every account tested with a real bank) sat stuck at
// pending_submission forever, gocardless_mandate_id never set — despite
// at least one confirmed case where the bank had genuinely notified the
// member their Direct Debit was set up. The mandate lifecycle webhook
// (api/webhooks/gocardless.js) has apparently never once been successfully
// processed for an 'active' event in production. This doesn't fix why —
// that needs Vercel's function logs, which aren't visible from here, to
// see whether GoCardless's deliveries are even reaching the endpoint —
// but it means Staff & Admin aren't stuck waiting on a webhook that,
// empirically, isn't working, and every affected account can be corrected
// now rather than staying wrong indefinitely.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();
  let requester;
  try {
    const auth = await requireAuth(req);
    requester = auth.member;
    if (!requester) return res.status(404).json({ error: 'No member record linked to this account' });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }
  if (requester.user_type !== 'administrator') {
    return res.status(403).json({ error: 'Only Staff & Admin can sync a mandate' });
  }

  const { member_id } = req.body || {};
  if (!member_id) return res.status(400).json({ error: 'member_id is required' });

  const { data: member, error: memberErr } = await supabase
    .from('members')
    .select('id, first_name, last_name, email, plan_tier, mandate_status, gocardless_mandate_id, gocardless_billing_request_id, gocardless_subscription_id, custom_monthly_fee_pence')
    .eq('id', member_id)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: 'Member not found' });
  if (!member.gocardless_billing_request_id && !member.gocardless_mandate_id) {
    return res.status(400).json({ error: 'This member has no Direct Debit setup on record to sync.' });
  }

  try {
    const { getGoCardlessClient, handleMandateBecameActive } = require('../_lib/gocardless');
    const client = getGoCardlessClient();

    let mandateId = null;
    let mandateStatus = null;

    if (member.gocardless_mandate_id) {
      const mandate = await client.mandates.find(member.gocardless_mandate_id);
      mandateId = mandate.id;
      mandateStatus = mandate.status;
    } else {
      // No mandate id on record yet — the only lead is the Billing Request
      // that started the flow. If GoCardless has since linked a mandate to
      // it (mandate_request_mandate), that's the mandate that was actually
      // created; if not, the Billing Request itself hasn't progressed and
      // there's genuinely nothing further to sync yet.
      const billingRequest = await client.billingRequests.find(member.gocardless_billing_request_id);
      const linkedMandateId = billingRequest.links && billingRequest.links.mandate_request_mandate;
      if (!linkedMandateId) {
        return res.status(200).json({
          ok: true, changed: false,
          billing_request_status: billingRequest.status,
          message: `GoCardless still shows this Billing Request as "${billingRequest.status}" — no mandate has been created from it yet.`,
        });
      }
      const mandate = await client.mandates.find(linkedMandateId);
      mandateId = mandate.id;
      mandateStatus = mandate.status;
    }

    // GoCardless's Mandate.status values map 1:1 onto what members.
    // mandate_status now allows (see the migration that extended its
    // CHECK constraint alongside this endpoint) — no translation needed,
    // just guard against an unrecognised value rather than writing it
    // blindly if GoCardless ever adds a new one.
    const knownStatuses = ['pending_customer_approval', 'pending_submission', 'submitted', 'active', 'cancelled', 'failed', 'expired', 'consumed', 'blocked', 'suspended_by_payer'];
    if (!knownStatuses.includes(mandateStatus)) {
      return res.status(502).json({ error: `GoCardless returned an unrecognised mandate status: "${mandateStatus}". Not written — check the GoCardless dashboard directly.` });
    }

    const wasActive = member.mandate_status === 'active';
    const nowActive = mandateStatus === 'active';

    const updates = { mandate_status: mandateStatus };
    if (mandateId) updates.gocardless_mandate_id = mandateId;

    const { data: updated, error: updateErr } = await supabase
      .from('members')
      .update(updates)
      .eq('id', member.id)
      .select('*')
      .single();
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    await logAudit({
      actorId: requester.id, actorName: `${requester.first_name || ''} ${requester.last_name || ''}`.trim(),
      action: 'billing.mandate_synced', entityType: 'member', entityId: member.id,
      details: { from: member.mandate_status, to: mandateStatus, mandate_id: mandateId },
    });

    // Only run the "just went active" side effects (email + subscription
    // setup) if this sync is what's newly discovering that — not on every
    // sync of an already-active mandate. handleMandateBecameActive is
    // idempotent regardless, but there's no reason to call it or resend
    // the email needlessly.
    if (nowActive && !wasActive) {
      await handleMandateBecameActive(supabase, updated);
    }

    return res.status(200).json({
      ok: true,
      changed: member.mandate_status !== mandateStatus,
      previous_status: member.mandate_status,
      new_status: mandateStatus,
    });
  } catch (e) {
    const detail = (e.errors && e.errors.length) ? e.errors.map(x => [x.field, x.message || x.reason].filter(Boolean).join(': ')).join('; ') : e.message;
    return res.status(502).json({ error: `GoCardless sync failed: ${detail}` });
  }
};
