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
 * Get effective spend rows for a tenant across a date range.
 *
 * @returns {Promise<Array<{
 *   id, source, periodStart, periodEnd,
 *   amountCents, reportedAmountCents,
 *   isManualOverride, sourceType,
 *   externalAccountId, externalCampaignId, metadata
 * }>>}
 */
async function getEffectiveSpend(supabase, { userId, startDate, endDate, source }) {
  let q = supabase
    .from('marketing_spend')
    .select('*')
    .eq('user_id', userId)
    .order('period_start', { ascending: true })

  if (source) q = q.eq('source', source)
  if (startDate) q = q.gte('period_end', startDate)   // any month whose end ≥ start of range
  if (endDate) q = q.lte('period_start', endDate)     //   and whose start ≤ end of range

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
async function getOpportunityCountsBySource(supabase, { userId, startDate, endDate }) {
  let q = supabase
    .from('opportunities')
    .select('id, source, opportunity_cost, budget_voided_at, created_at')
    .eq('user_id', userId)

  if (startDate) q = q.gte('created_at', startDate)
  if (endDate) q = q.lte('created_at', `${endDate} 23:59:59`)

  const { data, error } = await q
  if (error) throw error

  const counts = {}
  for (const row of data || []) {
    const src = (row.source || 'other').toLowerCase()
    if (!counts[src]) counts[src] = { count: 0, withCost: 0, sumCostCents: 0 }
    counts[src].count += 1
    if (row.opportunity_cost != null && row.budget_voided_at == null) {
      counts[src].withCost += 1
      counts[src].sumCostCents += Math.round(Number(row.opportunity_cost) * 100)
    }
  }
  return counts
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
async function getAdsSpendReport(supabase, { userId, startDate, endDate }) {
  const [rows, counts] = await Promise.all([
    getEffectiveSpend(supabase, { userId, startDate, endDate }),
    getOpportunityCountsBySource(supabase, { userId, startDate, endDate }),
  ])

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
}
