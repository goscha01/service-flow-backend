/**
 * Thumbtack historical cost backfill — service-side (endpoint-backed).
 *
 * Same logic as scripts/backfill-tt-opportunity-cost.js but runs inside
 * the backend process so:
 *   • no local Supabase/LB creds required
 *   • uses the per-tenant leadbridge_integration_token already stored
 *     in communication_settings
 *   • triggerable from the UI (Marketing spend "Backfill from LB" button)
 *
 * Hard rules (spec):
 *   • Never estimate. If LB has no leadPriceCents, leave SF NULL.
 *   • Never overwrite an existing NON-NULL opportunity_cost (preserves
 *     CSV-imported values + audit trail).
 *   • budget_voided_at is state — refresh (LB is authoritative).
 *   • Idempotent.
 *
 * Returns counters: eligible / updated / already_populated / lb_cost_unavailable / unmatched / failed
 */

const axios = require('axios')

const LB_BASE = process.env.LEADBRIDGE_URL || 'https://thumbtack-bridge-production.up.railway.app/api'

async function backfillThumbtackCost(supabase, logger, { userId, startDate = null, endDate = null, apply = false, limit = null }) {
  if (!userId) throw new Error('userId required')

  // 1. Resolve LB integration token
  const { data: settings } = await supabase
    .from('communication_settings')
    .select('leadbridge_integration_token')
    .eq('user_id', userId)
    .maybeSingle()
  const lbToken = settings?.leadbridge_integration_token
  if (!lbToken) {
    return { error: 'no_lb_token', message: 'ServiceFlow ↔ LeadBridge integration not connected for this tenant.' }
  }

  // 2. Load SF opportunities linked to a TT LB lead in the range.
  let oppQ = supabase
    .from('opportunities')
    .select('id, opportunity_cost, budget_voided_at, lb_external_request_id, lb_channel, created_at, source')
    .eq('user_id', userId)
    .not('lb_external_request_id', 'is', null)
    .or('lb_channel.eq.thumbtack,source.ilike.%thumbtack%')
  if (startDate) oppQ = oppQ.gte('created_at', startDate)
  if (endDate) oppQ = oppQ.lte('created_at', `${endDate} 23:59:59`)
  if (limit) oppQ = oppQ.limit(limit)

  const { data: sfOpps, error: oppErr } = await oppQ
  if (oppErr) throw oppErr

  if (!sfOpps || sfOpps.length === 0) {
    return { eligible: 0, updated: 0, already_populated: 0, lb_cost_unavailable: 0, unmatched: 0, failed: 0, applied: apply, note: 'no SF opportunities in range' }
  }

  // 3. Pull LB TT leads. Uses the same JWT the rest of leadbridge-service.js uses.
  let lbLeads
  try {
    const lbResp = await axios.get(`${LB_BASE}/v1/leads?scope=all&platform=thumbtack`, {
      headers: { Authorization: `Bearer ${lbToken}` },
      timeout: 45000,
    })
    lbLeads = lbResp.data?.leads || []
  } catch (e) {
    const status = e.response?.status || 0
    logger?.error?.(`[tt-cost-backfill] LB /v1/leads failed: ${status} ${e.message}`)
    if (status === 401) {
      return {
        error: 'lb_token_expired',
        status,
        message: 'Your LeadBridge session token has expired. Reconnect the integration in Settings → LeadBridge, then try again.',
      }
    }
    return { error: 'lb_fetch_failed', status, message: e.message }
  }
  logger?.log?.(`[tt-cost-backfill] user=${userId} lb_leads=${lbLeads.length} sf_opps=${sfOpps.length} apply=${apply}`)

  // 4. Index LB by externalRequestId.
  const lbIndex = {}
  for (const l of lbLeads) {
    if (!l.externalRequestId) continue
    lbIndex[String(l.externalRequestId)] = {
      leadPriceCents: l.leadPriceCents ?? null,
      budgetVoidedAt: l.budgetVoidedAt ?? null,
    }
  }

  // 5. Compute patches.
  const counters = {
    eligible: sfOpps.length,
    updated: 0,
    already_populated: 0,
    lb_cost_unavailable: 0,
    unmatched: 0,
    failed: 0,
  }
  const proposals = []
  for (const opp of sfOpps) {
    const lbHit = lbIndex[String(opp.lb_external_request_id)]
    if (!lbHit) { counters.unmatched += 1; continue }
    if (lbHit.leadPriceCents == null && lbHit.budgetVoidedAt == null) {
      counters.lb_cost_unavailable += 1; continue
    }
    const patch = {}
    if (opp.opportunity_cost == null && lbHit.leadPriceCents != null) {
      patch.opportunity_cost = Math.round(Number(lbHit.leadPriceCents)) / 100
    }
    const incomingVoid = lbHit.budgetVoidedAt ? new Date(lbHit.budgetVoidedAt).toISOString() : null
    const existingVoid = opp.budget_voided_at ? new Date(opp.budget_voided_at).toISOString() : null
    if (incomingVoid !== existingVoid) patch.budget_voided_at = incomingVoid

    if (Object.keys(patch).length === 0) {
      if (opp.opportunity_cost != null) counters.already_populated += 1
      else counters.lb_cost_unavailable += 1
      continue
    }
    proposals.push({ id: opp.id, patch })
  }

  // 6. Dry-run early return.
  if (!apply) {
    return { ...counters, proposals: proposals.length, applied: false, sample: proposals.slice(0, 3) }
  }

  // 7. Apply.
  for (const p of proposals) {
    const { error } = await supabase
      .from('opportunities')
      .update(p.patch)
      .eq('id', p.id)
      .eq('user_id', userId)
    if (error) {
      logger?.error?.(`[tt-cost-backfill] update failed id=${p.id}: ${error.message}`)
      counters.failed += 1
    } else {
      counters.updated += 1
    }
  }

  return { ...counters, applied: true, proposals: proposals.length }
}

module.exports = { backfillThumbtackCost }
