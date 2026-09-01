/**
 * Canonical read path for marketing spend.
 *
 * Every consumer (Analytics endpoints, Expenses UI, CPL/CAC/ROAS math)
 * MUST go through here. NEVER re-sum opportunities.opportunity_cost
 * independently — that column is the source of TRUTH for TT per-lead
 * cost, but its monthly aggregation lives ONLY in marketing_spend
 * (materialized by services/tt-spend-materializer.js). Double-counting
 * is prevented by making this the single query surface.
 *
 * Money model: all returned amounts are in CENTS (integer). Callers
 * that need dollars divide by 100 at the boundary.
 *
 * Unknown spend semantics: if a channel had activity in a period but
 * no marketing_spend row exists, the returned amountCents is `null`
 * (not 0). CPL/CAC/ROAS are `null` when denominators or numerators are
 * unknown.
 */

/**
 * Resolve a territory (SF location) to the set of LB provider_account_ids
 * that funnel leads into it. Returns [] when no mapping exists (which
 * yields empty results downstream — the correct "no data for this
 * location" behavior).
 *
 * Tenant isolation: communication_account_location_mappings doesn't carry
 * user_id directly (it's workspace-scoped). We enforce isolation by first
 * loading the tenant's LeadBridge provider accounts, then narrowing the
 * mapping lookup to that set.
 *
 * Table chain (mig 006 + 008 + 009):
 *   communication_provider_accounts (user_id, provider='leadbridge')
 *   .id → communication_account_location_mappings.provider_account_id
 *   communication_account_location_mappings.sf_location_id → territories.id
 *
 * @param {object} supabase
 * @param {number} userId
 * @param {number|string} territoryId
 * @returns {Promise<Array<number>>}
 */
async function getLbAccountsForTerritory(supabase, userId, territoryId) {
  if (!territoryId || territoryId === 'all') return null   // null sentinel = no filter

  const { data: accounts, error: acctErr } = await supabase
    .from('communication_provider_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'leadbridge')
  if (acctErr) throw acctErr

  const accountIds = (accounts || []).map((a) => a.id)
  if (accountIds.length === 0) return []

  const { data: mappings, error: mapErr } = await supabase
    .from('communication_account_location_mappings')
    .select('provider_account_id')
    .in('provider_account_id', accountIds)
    .eq('sf_location_id', territoryId)
  if (mapErr) throw mapErr

  return (mappings || [])
    .map((r) => r.provider_account_id)
    .filter((v) => v != null)
}

/**
 * Get effective spend rows for a tenant across a date range.
 *
 * @param {object} opts
 * @param {number|null} [opts.locationId] - Territory id. When set, only
 *   marketing_spend rows whose external_account_id maps to that territory
 *   are returned. Rows with null external_account_id are treated as
 *   tenant-level and EXCLUDED from location-scoped queries (because we
 *   can't attribute them safely).
 *
 * @returns {Promise<Array<{...}>>}
 */
async function getEffectiveSpend(supabase, { userId, startDate, endDate, source, locationId = null }) {
  let allowedAccounts = null
  if (locationId != null && locationId !== 'all') {
    allowedAccounts = await getLbAccountsForTerritory(supabase, userId, locationId)
    if (!allowedAccounts || allowedAccounts.length === 0) return []
  }

  let q = supabase
    .from('marketing_spend')
    .select('*')
    .eq('user_id', userId)
    .order('period_start', { ascending: true })

  if (source) q = q.eq('source', source)
  if (startDate) q = q.gte('period_end', startDate)   // any month whose end ≥ start of range
  if (endDate) q = q.lte('period_start', endDate)     //   and whose start ≤ end of range
  if (allowedAccounts) q = q.in('external_account_id', allowedAccounts.map(String))

  const { data, error } = await q
  if (error) throw error
  return (data || []).map((r) => ({
    id: r.id,
    source: r.source,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    amountCents: r.amount_cents != null ? Number(r.amount_cents) : null,
    reportedAmountCents: r.reported_amount_cents != null ? Number(r.reported_amount_cents) : null,
    isManualOverride: !!r.is_manual_override,
    sourceType: r.source_type,
    externalAccountId: r.external_account_id,
    externalCampaignId: r.external_campaign_id,
    metadata: r.metadata,
  }))
}

/**
 * Roll up spend by (source, YYYY-MM). Sums multi-account rows within
 * the same source+month. Preserves is_manual_override=true if ANY
 * contributing row is a manual override.
 *
 * @returns {Array<{ source, monthKey, monthLabel, amountCents, reportedAmountCents, isManualOverride, sourceTypes: string[] }>}
 */
function rollupByMonth(rows) {
  const bucket = {}
  for (const r of rows) {
    const [y, m] = r.periodStart.split('-')
    const monthKey = `${y}-${m}`
    const key = `${r.source}::${monthKey}`
    if (!bucket[key]) {
      bucket[key] = {
        source: r.source,
        monthKey,
        monthLabel: monthLabel(parseInt(y, 10), parseInt(m, 10)),
        amountCents: 0,
        reportedAmountCents: null,
        isManualOverride: false,
        sourceTypes: new Set(),
      }
    }
    const b = bucket[key]
    b.amountCents += r.amountCents || 0
    if (r.reportedAmountCents != null) {
      b.reportedAmountCents = (b.reportedAmountCents || 0) + r.reportedAmountCents
    }
    if (r.isManualOverride) b.isManualOverride = true
    b.sourceTypes.add(r.sourceType)
  }
  return Object.values(bucket).map((b) => ({
    ...b,
    sourceTypes: Array.from(b.sourceTypes),
  })).sort((a, b) => (a.monthKey < b.monthKey ? -1 : 1))
}

/**
 * Roll up by source (across the entire range).
 */
function rollupBySource(rows) {
  const bucket = {}
  for (const r of rows) {
    if (!bucket[r.source]) {
      bucket[r.source] = {
        source: r.source,
        amountCents: 0,
        reportedAmountCents: null,
        isManualOverride: false,
        sourceTypes: new Set(),
        months: 0,
      }
    }
    const b = bucket[r.source]
    b.amountCents += r.amountCents || 0
    if (r.reportedAmountCents != null) {
      b.reportedAmountCents = (b.reportedAmountCents || 0) + r.reportedAmountCents
    }
    if (r.isManualOverride) b.isManualOverride = true
    b.sourceTypes.add(r.sourceType)
    b.months += 1
  }
  return Object.values(bucket)
    .map((b) => ({ ...b, sourceTypes: Array.from(b.sourceTypes) }))
    .sort((a, b) => b.amountCents - a.amountCents)
}

/**
 * Count opportunities per source in a date range — feeds CPL denominators.
 * Uses `opportunities.created_at` (acquisition event time) and canonical source.
 *
 * @returns {Promise<Record<string, { count: number, withCost: number, sumCostCents: number }>>}
 */
async function getOpportunityCountsBySource(supabase, { userId, startDate, endDate, locationId = null }) {
  let allowedAccounts = null
  if (locationId != null && locationId !== 'all') {
    allowedAccounts = await getLbAccountsForTerritory(supabase, userId, locationId)
    if (!allowedAccounts || allowedAccounts.length === 0) return {}
  }

  let q = supabase
    .from('opportunities')
    .select('id, source, lb_channel, lb_provider_account_id, opportunity_cost, budget_voided_at, created_at')
    .eq('user_id', userId)

  if (startDate) q = q.gte('created_at', startDate)
  if (endDate) q = q.lte('created_at', `${endDate} 23:59:59`)
  if (allowedAccounts) q = q.in('lb_provider_account_id', allowedAccounts)

  const { data, error } = await q
  if (error) throw error

  const counts = {}
  for (const row of data || []) {
    // Key by canonical channel so CPL denominators find opportunities that
    // marketing_spend groups under. lb_channel is the authoritative channel
    // label (LB writes 'thumbtack' / 'yelp'). Falls back to source only when
    // no LB linkage exists (CSV import, manual entry). Loosely matches
    // per-account source labels like "Georgiy Sayapin (thumbtack)" too.
    const src = canonicalChannel(row)
    if (!counts[src]) counts[src] = { count: 0, withCost: 0, sumCostCents: 0 }
    counts[src].count += 1
    if (row.opportunity_cost != null && row.budget_voided_at == null) {
      counts[src].withCost += 1
      counts[src].sumCostCents += Math.round(Number(row.opportunity_cost) * 100)
    }
  }
  return counts
}

// Extract the canonical channel key from an opportunities row.
// Priority: explicit lb_channel > source string containing a known channel
// name > 'other'.
function canonicalChannel(row) {
  const lc = row.lb_channel != null ? String(row.lb_channel).toLowerCase() : null
  if (lc === 'thumbtack' || lc === 'yelp') return lc
  const s = (row.source || '').toLowerCase()
  if (s.includes('thumbtack')) return 'thumbtack'
  if (s.includes('yelp')) return 'yelp'
  if (s.includes('google_ads') || s.includes('google ads')) return 'google_ads'
  if (s.includes('meta') || s.includes('facebook')) return 'meta_ads'
  if (s.includes('lsa') || s.includes('local services')) return 'google_lsa'
  return s || 'other'
}

/**
 * Compose the full "expenses > ads" payload used by the Analytics ads-spend
 * endpoint. Returns effective (Analytics-facing) numbers only; the frontend
 * separately fetches raw rows for the editable table.
 *
 * CPL = amountCents / opportunityCount (null when either denominator is
 * missing or spend is unknown).
 *
 * @returns {Promise<{
 *   summary: { totalSpendCents, opportunityCount, avgCplCents },
 *   bySource: Array<{ source, spendCents, leadCount, cplCents, months, isManualOverride, sourceTypes }>,
 *   monthly:  Array<{ monthKey, monthLabel, spendCents, bySource: Record<string, number> }>
 * }>}
 */
async function getAdsSpendReport(supabase, { userId, startDate, endDate, locationId = null }) {
  const isLocationScoped = locationId != null && locationId !== 'all'
  const [rows, counts] = await Promise.all([
    getEffectiveSpend(supabase, { userId, startDate, endDate, locationId }),
    getOpportunityCountsBySource(supabase, { userId, startDate, endDate, locationId }),
  ])

  // For location-scoped queries, marketing_spend rows without an
  // external_account_id can't be attributed to a location. Materialized
  // Thumbtack rows created before per-account splitting all fall in that
  // bucket. Bridge by computing TT spend on-the-fly from filtered
  // opportunities.opportunity_cost (the same source the materializer
  // uses) so location-filtered spend numbers are non-zero out of the box.
  //
  // Semantics: TT spend for a location = SUM(opportunity_cost) of ops
  // whose lb_provider_account_id is mapped to that location AND not
  // budget_voided.
  if (isLocationScoped) {
    const ttCents = (counts['thumbtack'] && counts['thumbtack'].sumCostCents) || 0
    if (ttCents > 0 && !rows.some((r) => r.source === 'thumbtack')) {
      // Synthesize a single tenant-scoped row for TT so the rollup includes it.
      rows.push({
        id: null,
        source: 'thumbtack',
        periodStart: startDate || null,
        periodEnd: endDate || null,
        amountCents: ttCents,
        reportedAmountCents: ttCents,
        isManualOverride: false,
        sourceType: 'derived_from_opportunities',
        externalAccountId: null,
        externalCampaignId: null,
        metadata: { synthetic: true, reason: 'location_scoped_from_opportunity_cost' },
      })
    }
  }

  const bySourceRaw = rollupBySource(rows)
  const monthlyRaw = rollupByMonth(rows)

  const bySource = bySourceRaw.map((s) => {
    const c = counts[s.source] || { count: 0 }
    const leadCount = c.count
    const cplCents = leadCount > 0 ? Math.round(s.amountCents / leadCount) : null
    return {
      source: s.source,
      spendCents: s.amountCents,
      reportedSpendCents: s.reportedAmountCents,
      leadCount,
      cplCents,
      months: s.months,
      isManualOverride: s.isManualOverride,
      sourceTypes: s.sourceTypes,
    }
  })

  // Include channels that have OPPORTUNITY counts but no spend row.
  // Otherwise a location with matched leads but no cost data (e.g.
  // Jacksonville TT where the backfill didn't fill opportunity_cost)
  // would disappear from bySource entirely. Frontend needs to render
  // "N leads · spend unknown".
  const spendKeys = new Set(bySource.map((r) => r.source))
  for (const [channel, c] of Object.entries(counts)) {
    if (spendKeys.has(channel)) continue
    if (!c.count) continue
    bySource.push({
      source: channel,
      spendCents: null,        // unknown, not $0
      reportedSpendCents: null,
      leadCount: c.count,
      cplCents: null,
      months: 0,
      isManualOverride: false,
      sourceTypes: [],
    })
  }
  bySource.sort((a, b) => (b.spendCents || 0) - (a.spendCents || 0) || b.leadCount - a.leadCount)

  // Monthly rollup — flatten to { monthKey, monthLabel, spendCents, bySource }
  const monthlyMap = {}
  for (const m of monthlyRaw) {
    if (!monthlyMap[m.monthKey]) {
      monthlyMap[m.monthKey] = {
        monthKey: m.monthKey,
        monthLabel: m.monthLabel,
        spendCents: 0,
        bySource: {},
      }
    }
    monthlyMap[m.monthKey].spendCents += m.amountCents
    monthlyMap[m.monthKey].bySource[m.source] = (monthlyMap[m.monthKey].bySource[m.source] || 0) + m.amountCents
  }

  const totalSpendCents = bySourceRaw.reduce((s, r) => s + r.amountCents, 0)
  const totalOpportunityCount = Object.values(counts).reduce((s, c) => s + c.count, 0)
  const avgCplCents = totalOpportunityCount > 0 ? Math.round(totalSpendCents / totalOpportunityCount) : null

  return {
    summary: {
      totalSpendCents,
      opportunityCount: totalOpportunityCount,
      avgCplCents,
    },
    bySource,
    monthly: Object.values(monthlyMap).sort((a, b) => (a.monthKey < b.monthKey ? -1 : 1)),
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function monthLabel(year, month) {
  const d = new Date(Date.UTC(year, month - 1, 1))
  return d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
}

module.exports = {
  getEffectiveSpend,
  rollupByMonth,
  rollupBySource,
  getOpportunityCountsBySource,
  getAdsSpendReport,
  getLbAccountsForTerritory,
}
