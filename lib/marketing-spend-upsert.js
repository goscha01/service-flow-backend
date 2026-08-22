/**
 * Upsert helper for the marketing_spend table.
 *
 * The single write path used by:
 *   • services/tt-spend-materializer.js (Thumbtack monthly derivation)
 *   • Any future upstream sync (Yelp API, Google Ads API, Meta, LSA…)
 *
 * The CRUD router (marketing-spend-service.js) does NOT go through here —
 * it writes to `amount_cents` directly with `is_manual_override=true`.
 *
 * Contract:
 *   • Always writes `reported_amount_cents = incoming.amount_cents`.
 *   • If `is_manual_override = true` on the existing row → NEVER overwrites
 *     `amount_cents`. This preserves user edits across syncs.
 *   • If new row or `is_manual_override = false` → `amount_cents := incoming.amount_cents`.
 *   • Returns { action: 'created' | 'updated' | 'skipped_no_data', row }.
 *
 * Idempotent — re-running with the same input is a no-op (updated fields
 * are identical, `is_manual_override` unchanged).
 */

/**
 * @param {object} supabase — service-role client
 * @param {object} args
 * @param {number} args.userId
 * @param {string} args.source                 — e.g. 'thumbtack'
 * @param {string} args.periodStart            — 'YYYY-MM-DD' (month start)
 * @param {string} args.periodEnd              — 'YYYY-MM-DD' (last day of month)
 * @param {number|null} args.amountCents       — new reported/effective amount; null means "no upstream data"
 * @param {string} args.sourceType             — provenance (must satisfy CHECK constraint)
 * @param {string|null} [args.externalAccountId]
 * @param {string|null} [args.externalCampaignId]
 * @param {object|null} [args.metadata]        — merged into existing metadata
 * @returns {Promise<{action, row, previousAmountCents}>}
 */
async function upsertReportedSpend(supabase, args) {
  const {
    userId, source, periodStart, periodEnd,
    amountCents, sourceType,
    externalAccountId = null, externalCampaignId = null, metadata = null,
  } = args

  // "Unknown spend ≠ $0" — if upstream has nothing, do not create a row.
  // Skip is preferable to writing 0 because Analytics distinguishes "no data"
  // from "zero spend".
  if (amountCents == null) return { action: 'skipped_no_data', row: null, previousAmountCents: null }
  if (!Number.isFinite(amountCents) || amountCents < 0) {
    throw new Error(`upsertReportedSpend: invalid amountCents=${amountCents}`)
  }

  const roundedCents = Math.round(amountCents)

  // Find existing row.
  let findQ = supabase
    .from('marketing_spend')
    .select('*')
    .eq('user_id', userId)
    .eq('source', source)
    .eq('period_start', periodStart)
  if (externalAccountId == null) findQ = findQ.is('external_account_id', null)
  else findQ = findQ.eq('external_account_id', externalAccountId)

  const { data: existing } = await findQ.maybeSingle()

  if (!existing) {
    const { data, error } = await supabase
      .from('marketing_spend')
      .insert({
        user_id: userId,
        source,
        period_start: periodStart,
        period_end: periodEnd,
        amount_cents: roundedCents,
        reported_amount_cents: roundedCents,
        is_manual_override: false,
        source_type: sourceType,
        external_account_id: externalAccountId,
        external_campaign_id: externalCampaignId,
        metadata,
      })
      .select()
      .single()
    if (error) throw error
    return { action: 'created', row: data, previousAmountCents: null }
  }

  // Existing row — respect the override flag.
  const patch = {
    reported_amount_cents: roundedCents,
    source_type: existing.is_manual_override ? existing.source_type : sourceType,
    external_campaign_id: externalCampaignId ?? existing.external_campaign_id,
    metadata: metadata ? { ...(existing.metadata || {}), ...metadata } : existing.metadata,
    updated_at: new Date().toISOString(),
  }
  if (!existing.is_manual_override) {
    patch.amount_cents = roundedCents
  }

  const { data, error } = await supabase
    .from('marketing_spend')
    .update(patch)
    .eq('id', existing.id)
    .select()
    .single()
  if (error) throw error

  return {
    action: 'updated',
    row: data,
    previousAmountCents: existing.amount_cents,
  }
}

module.exports = { upsertReportedSpend }
