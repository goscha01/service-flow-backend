'use strict';

/**
 * Marketing spend materialization cron.
 *
 * Nightly (~) sweep that re-materializes each tenant's Thumbtack monthly
 * marketing_spend rows from opportunities.opportunity_cost. Idempotent —
 * respects manual overrides via the same lib/marketing-spend-upsert.js
 * path used by the on-demand endpoint.
 *
 * Why: new TT leads arrive via LB webhooks carrying leadPriceCents
 * (persisted to opportunities.opportunity_cost automatically), so the
 * raw data flows in real time. But the monthly rollup only lives in
 * marketing_spend after the materializer runs. This cron keeps the
 * rollup fresh without the operator having to click "Sync from
 * LeadBridge" every day.
 *
 * Scope: last 3 months rolling window. Covers late-arriving TT charge
 * hydration (chargeState refresh, refund events) without wasting time
 * on ancient months. Historical months stay whatever the operator
 * backfilled or manually set.
 *
 * Multi-layered gating:
 *
 *   MARKETING_SPEND_MATERIALIZE_ENABLED   Must equal 'true' to run.
 *                                          Default: not set (cron does not run).
 *   MARKETING_SPEND_MATERIALIZE_TENANTS    Optional CSV of user_ids to include.
 *                                          When set, only listed tenants processed.
 *                                          Empty/unset → all connected tenants.
 *   MARKETING_SPEND_MATERIALIZE_INTERVAL_MS  Tick cadence. Default 24h.
 *   MARKETING_SPEND_MATERIALIZE_LOOKBACK_MONTHS  Months to re-materialize.
 *                                          Default 3.
 *
 * Race safety: single-boot guard via `running` flag. Idempotent writes
 * mean multi-replica duplicate runs are benign.
 */

const { materializeThumbtackSpend } = require('../services/tt-spend-materializer');

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
function envFlag(name) {
  const v = (process.env[name] || '').toLowerCase();
  return TRUE_VALUES.has(v);
}
function envInt(name, defaultValue) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : defaultValue;
}
function envTenantSet() {
  const raw = process.env.MARKETING_SPEND_MATERIALIZE_TENANTS;
  if (!raw) return null;
  const ids = String(raw).split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
  const set = new Set(ids.filter(n => Number.isFinite(n)));
  return set.size > 0 ? set : null;
}

// Rolling window: last N months (default 3), anchored to today.
function computeRange(lookbackMonths) {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));   // last day of current month
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (lookbackMonths - 1), 1));  // first day of window
  const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { startDate: iso(start), endDate: iso(end) };
}

function start(supabase, logger) {
  if (!envFlag('MARKETING_SPEND_MATERIALIZE_ENABLED')) {
    logger?.log?.('[marketing-spend-cron] disabled (set MARKETING_SPEND_MATERIALIZE_ENABLED=true to enable)');
    return null;
  }

  const intervalMs = envInt('MARKETING_SPEND_MATERIALIZE_INTERVAL_MS', 24 * 60 * 60 * 1000);
  const lookbackMonths = envInt('MARKETING_SPEND_MATERIALIZE_LOOKBACK_MONTHS', 3);
  const tenantFilter = envTenantSet();

  let running = false;

  const tick = async () => {
    if (running) {
      logger?.log?.('[marketing-spend-cron] previous tick still running; skipping this cycle');
      return;
    }
    running = true;
    const startedAt = Date.now();
    try {
      const { startDate, endDate } = computeRange(lookbackMonths);
      logger?.log?.(`[marketing-spend-cron] tick start range=${startDate}..${endDate} lookback=${lookbackMonths}mo`);

      // Enumerate tenants that have any LB linkage. Materializer skips
      // months with no coverage anyway, but this avoids empty loops.
      let q = supabase
        .from('communication_settings')
        .select('user_id')
        .not('leadbridge_integration_token', 'is', null);
      const { data: tenants, error } = await q;
      if (error) throw error;

      let tenantCount = 0;
      let totalCreated = 0;
      let totalUpdated = 0;
      let totalCents = 0;

      for (const t of tenants || []) {
        if (tenantFilter && !tenantFilter.has(Number(t.user_id))) continue;
        tenantCount += 1;
        try {
          const result = await materializeThumbtackSpend(supabase, logger, {
            userId: t.user_id,
            startDate,
            endDate,
          });
          totalCreated += result.rowsCreated;
          totalUpdated += result.rowsUpdated;
          totalCents += result.totalCents;
        } catch (e) {
          logger?.warn?.(`[marketing-spend-cron] tenant ${t.user_id} failed: ${e.message}`);
        }
      }

      const durationMs = Date.now() - startedAt;
      logger?.log?.(
        `[marketing-spend-cron] tick complete tenants=${tenantCount} created=${totalCreated} updated=${totalUpdated} total_cents=${totalCents} duration_ms=${durationMs}`,
      );
    } catch (e) {
      logger?.error?.(`[marketing-spend-cron] tick fatal: ${e.message}`);
    } finally {
      running = false;
    }
  };

  logger?.log?.(`[marketing-spend-cron] starting · interval=${intervalMs}ms · lookback=${lookbackMonths}mo${tenantFilter ? ` · tenants=[${Array.from(tenantFilter).join(',')}]` : ' · all tenants'}`);

  // Fire once on boot after a short delay so we don't collide with app startup,
  // then repeat on interval.
  const bootDelay = envInt('MARKETING_SPEND_MATERIALIZE_BOOT_DELAY_MS', 60 * 1000);
  const bootTimer = setTimeout(tick, bootDelay);
  const intervalTimer = setInterval(tick, intervalMs);

  return {
    stop() {
      clearTimeout(bootTimer);
      clearInterval(intervalTimer);
    },
  };
}

module.exports = { start, computeRange };
