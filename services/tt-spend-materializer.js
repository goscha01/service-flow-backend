/**
 * Thumbtack monthly-spend materializer.
 *
 * The ONLY path from per-lead opportunity_cost to per-month marketing_spend
 * rows. Runs idempotently — safe to invoke repeatedly per user × month.
 *
 * Aggregation rule (mirrors LB's own analytics filter):
 *   SUM(opportunity_cost * 100)
 *   FROM opportunities
 *   WHERE user_id = $1
 *     AND source = 'thumbtack'
 *     AND opportunity_cost IS NOT NULL
 *     AND budget_voided_at IS NULL              -- refund-aware
 *     AND created_at BETWEEN month_start AND month_end
 *
 * Excludes months with ZERO opportunity_cost coverage — an unknown month
 * ≠ $0 month. When all TT opportunities have NULL cost for a month, we
 * skip the row rather than writing 0.
 *
 * Manual override protection: delegated to lib/marketing-spend-upsert.js.
 * If the user has manually pinned a TT month's amount, the derivation
 * only refreshes reported_amount_cents; amount_cents stays.
 *
 * Multi-account tenants: opportunities carry lb_provider_account_id.
 * We roll up ACROSS accounts by default (one marketing_spend row per
 * source+month). Per-account materialization is a future opt-in — pass
 * { splitByAccount: true } to enable.
 */

const { upsertReportedSpend } = require('../lib/marketing-spend-upsert')

// Source keys retained for the tests (exact-match short values e.g. CSV import).
// The production query uses a permissive filter (lb_channel=thumbtack OR
// source ILIKE '%thumbtack%') because pickLBSources writes per-account labels
// like "Georgiy Sayapin (thumbtack)" — an exact list would miss them.
const TT_SOURCE_KEYS = ['thumbtack', 'Thumbtack', 'THUMBTACK']

/**
 * @returns {Promise<{
 *   monthsProcessed: number,
 *   rowsCreated: number,
 *   rowsUpdated: number,
 *   rowsSkippedNoCoverage: number,
 *   rowsSkippedOverride: number,
 *   totalCents: number,
 *   details: Array<{ monthKey, action, amountCents, previousAmountCents, overrideActive }>
 * }>}
 */
async function materializeThumbtackSpend(supabase, logger, { userId, startDate, endDate, splitByAccount = false }) {
  if (!userId) throw new Error('userId required')

  // Resolve the range's month buckets in UTC.
  const start = normalizeDate(startDate)
  const end = normalizeDate(endDate)
  if (!start || !end || start > end) {
    throw new Error(`Invalid date range: ${startDate} → ${endDate}`)
  }

  const months = enumerateMonths(start, end)

  // Pull all TT opportunities in the range in one query.
  const startStr = start.toISOString().slice(0, 10)
  const endStr = end.toISOString().slice(0, 10)

  // Match Thumbtack the same way the backfill does: lb_channel exact, OR
  // source label contains 'thumbtack' (case-insensitive). pickLBSources
  // writes per-account labels like "Georgiy Sayapin (thumbtack)" — an
  // exact source='thumbtack' filter misses those. CSV-imported rows keep
  // matching via the ILIKE branch too.
  const { data: opps, error } = await supabase
    .from('opportunities')
    .select('id, source, lb_channel, opportunity_cost, budget_voided_at, created_at, lb_provider_account_id')
    .eq('user_id', userId)
    .or('lb_channel.eq.thumbtack,source.ilike.%thumbtack%')
    .gte('created_at', startStr)
    .lte('created_at', `${endStr} 23:59:59`)

  if (error) throw error

  // Bucket by (yyyy-mm) or (yyyy-mm, accountId) if splitByAccount.
  const buckets = {}
  for (const o of opps || []) {
    const d = new Date(o.created_at)
    if (Number.isNaN(d.getTime())) continue
    const key = bucketKeyFor(d, splitByAccount ? o.lb_provider_account_id : null)
    if (!buckets[key]) {
      buckets[key] = {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        accountId: splitByAccount ? (o.lb_provider_account_id || null) : null,
        totalOpps: 0,
        oppsWithCost: 0,
        sumCents: 0,
      }
    }
    const b = buckets[key]
    b.totalOpps += 1
    if (o.opportunity_cost != null && o.budget_voided_at == null) {
      b.oppsWithCost += 1
      b.sumCents += Math.round(Number(o.opportunity_cost) * 100)
    }
  }

  // For each month in range, upsert (or skip).
  let rowsCreated = 0
  let rowsUpdated = 0
  let rowsSkippedNoCoverage = 0
  let rowsSkippedOverride = 0
  let totalCents = 0
  const details = []

  for (const monthMeta of months) {
    // Collect all buckets that fall inside this month.
    const monthBuckets = Object.values(buckets).filter(
      (b) => b.year === monthMeta.year && b.month === monthMeta.month,
    )

    if (monthBuckets.length === 0) {
      rowsSkippedNoCoverage += 1
      details.push({ monthKey: monthMeta.monthKey, action: 'skipped', reason: 'no_opportunities', amountCents: null })
      continue
    }

    // Group by account (or single group when !splitByAccount).
    const groups = splitByAccount
      ? monthBuckets
      : [monthBuckets.reduce((acc, b) => ({
          ...acc,
          totalOpps: acc.totalOpps + b.totalOpps,
          oppsWithCost: acc.oppsWithCost + b.oppsWithCost,
          sumCents: acc.sumCents + b.sumCents,
          accountId: null,
        }), { year: monthMeta.year, month: monthMeta.month, accountId: null, totalOpps: 0, oppsWithCost: 0, sumCents: 0 })]

    for (const g of groups) {
      if (g.oppsWithCost === 0) {
        // Opportunities exist but ALL costs are null → unknown, don't write 0.
        rowsSkippedNoCoverage += 1
        details.push({
          monthKey: monthMeta.monthKey,
          accountId: g.accountId,
          action: 'skipped',
          reason: 'no_cost_coverage',
          amountCents: null,
          totalOpps: g.totalOpps,
        })
        continue
      }

      const result = await upsertReportedSpend(supabase, {
        userId,
        source: 'thumbtack',
        periodStart: monthMeta.periodStart,
        periodEnd: monthMeta.periodEnd,
        amountCents: g.sumCents,
        sourceType: 'derived_from_opportunities',
        externalAccountId: g.accountId ? String(g.accountId) : null,
        metadata: {
          derivation: {
            total_opportunities: g.totalOpps,
            opportunities_with_cost: g.oppsWithCost,
            derived_at: new Date().toISOString(),
          },
        },
      })

      if (result.action === 'created') rowsCreated += 1
      else if (result.action === 'updated') {
        rowsUpdated += 1
        if (result.row && result.row.is_manual_override) {
          // The upsert ran but the manual override preserved amount_cents;
          // still count this as "override was active" for observability.
          rowsSkippedOverride += 1
        }
      }
      totalCents += g.sumCents
      details.push({
        monthKey: monthMeta.monthKey,
        accountId: g.accountId,
        action: result.action,
        amountCents: g.sumCents,
        previousAmountCents: result.previousAmountCents,
        overrideActive: !!(result.row && result.row.is_manual_override),
      })
    }
  }

  logger?.log?.(
    `[tt-spend-materializer] user=${userId} range=${startStr}..${endStr} months=${months.length} created=${rowsCreated} updated=${rowsUpdated} skipped_no_coverage=${rowsSkippedNoCoverage} override_active=${rowsSkippedOverride} total_cents=${totalCents}`,
  )

  return {
    monthsProcessed: months.length,
    rowsCreated,
    rowsUpdated,
    rowsSkippedNoCoverage,
    rowsSkippedOverride,
    totalCents,
    details,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function normalizeDate(input) {
  if (!input) return null
  if (input instanceof Date) return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()))
  const [y, m, d] = String(input).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(Date.UTC(y, m - 1, d))
}

function bucketKeyFor(date, accountId) {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  return accountId ? `${y}-${m}::${accountId}` : `${y}-${m}`
}

function enumerateMonths(start, end) {
  const out = []
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const endMonthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  while (cursor <= endMonthStart) {
    const y = cursor.getUTCFullYear()
    const m = cursor.getUTCMonth() + 1
    const monthEnd = new Date(Date.UTC(y, m, 0))
    out.push({
      year: y,
      month: m,
      monthKey: `${y}-${String(m).padStart(2, '0')}`,
      periodStart: `${y}-${String(m).padStart(2, '0')}-01`,
      periodEnd: `${monthEnd.getUTCFullYear()}-${String(monthEnd.getUTCMonth() + 1).padStart(2, '0')}-${String(monthEnd.getUTCDate()).padStart(2, '0')}`,
    })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return out
}

module.exports = {
  materializeThumbtackSpend,
  TT_SOURCE_KEYS,
  enumerateMonths,
}
