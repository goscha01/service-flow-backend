'use strict';

/**
 * ZB team-member availability reconciliation cron.
 *
 * Nightly-ish pull of provider availability from ZB /timeslots, folded into
 * team_members.availability.customAvailability envelope entries. See
 * lib/zenbooker-availability-reconcile.js for the reconcile semantics.
 *
 * Multi-layered gating (hard to enable accidentally):
 *
 *   ZB_AVAIL_RECONCILE_ENABLED           Must equal 'true' for the cron to start.
 *                                        Default: not set (cron does not run).
 *   ZB_AVAIL_RECONCILE_APPLY             Must equal 'true' for writes.
 *                                        Default: dry-run.
 *   ZB_AVAIL_RECONCILE_TENANTS           Optional CSV of user_ids to include.
 *                                        When set, only listed tenants are
 *                                        processed. Empty/unset → all connected.
 *   ZB_AVAIL_RECONCILE_INTERVAL_MS       Tick cadence. Default 24h.
 *   ZB_AVAIL_RECONCILE_LOOKAHEAD_DAYS    /timeslots days. Default 60 (ZB max).
 *   ZB_AVAIL_RECONCILE_PROBE_DURATION_MIN /timeslots duration. Default 60.
 *   ZB_AVAIL_RECONCILE_PER_PROVIDER_DELAY_MS  ZB pacing. Default 250ms.
 *
 * No advisory-lock DB dependency — writes are idempotent (same /timeslots
 * response → identical customAvailability payload). Multi-replica duplicate
 * runs waste API calls but do not corrupt data. Single-replica boot guards
 * against overlapping ticks via a `running` flag below.
 */

const { reconcileTenantAvailability } = require('../lib/zenbooker-availability-reconcile');

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
function envFlag(name) {
  const v = (process.env[name] || '').toLowerCase();
  return TRUE_VALUES.has(v);
}
function envInt(name, defaultValue) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : defaultValue;
}
function envIntZeroOk(name, defaultValue) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : defaultValue;
}
function envTenantSet() {
  const raw = process.env.ZB_AVAIL_RECONCILE_TENANTS;
  if (!raw) return null;
  const ids = String(raw).split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
  const set = new Set(ids.filter(n => Number.isFinite(n)));
  return set.size > 0 ? set : null;
}

const ENABLED = () => envFlag('ZB_AVAIL_RECONCILE_ENABLED');
const APPLY = () => envFlag('ZB_AVAIL_RECONCILE_APPLY');
const INTERVAL_MS = () => envInt('ZB_AVAIL_RECONCILE_INTERVAL_MS', 24 * 3600 * 1000);
const LOOKAHEAD_DAYS = () => envInt('ZB_AVAIL_RECONCILE_LOOKAHEAD_DAYS', 60);
const PROBE_DURATION_MIN = () => envInt('ZB_AVAIL_RECONCILE_PROBE_DURATION_MIN', 60);
const PER_PROVIDER_DELAY_MS = () => envIntZeroOk('ZB_AVAIL_RECONCILE_PER_PROVIDER_DELAY_MS', 250);

const ZB_BASE = 'https://api.zenbooker.com/v1';

async function zbFetch(apiKey, path, params = {}) {
  const url = new URL(`${ZB_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Zenbooker API ${res.status}: ${body}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function runReconcileTick({ supabase, logger = console }) {
  if (!ENABLED()) return { skipped: 'disabled' };

  const apply = APPLY();
  const tenantAllowlist = envTenantSet();
  const lookaheadDays = LOOKAHEAD_DAYS();
  const probeDurationMin = PROBE_DURATION_MIN();
  const perProviderDelayMs = PER_PROVIDER_DELAY_MS();

  const { data: users, error: usersErr } = await supabase
    .from('users')
    .select('id, zenbooker_api_key')
    .eq('zenbooker_status', 'connected')
    .not('zenbooker_api_key', 'is', null);
  if (usersErr) {
    logger.error(`[ZBAvailabilityReconcileCron] users query failed: ${usersErr.message}`);
    return { error: 'users_query_failed' };
  }

  let tenants = (users || []).filter(u => u.zenbooker_api_key);
  if (tenantAllowlist) {
    tenants = tenants.filter(u => tenantAllowlist.has(Number(u.id)));
  }

  logger.log(
    `[ZBAvailabilityReconcileCron] tick starting — tenants=${tenants.length} apply=${apply} ` +
    `lookahead=${lookaheadDays}d probeDuration=${probeDurationMin}m ` +
    `allowlist=${tenantAllowlist ? Array.from(tenantAllowlist).join(',') : 'all'}`
  );

  const tickSummary = {
    tenants: tenants.length,
    tenantsProcessed: 0,
    tenantFailures: 0,
    totals: {
      scanned: 0,
      written: 0,
      would_write: 0,
      no_change: 0,
      skipped_no_zb_id: 0,
      skipped_no_territories: 0,
      skipped_fetch_failed: 0,
      failures: 0,
    },
  };

  for (const tenant of tenants) {
    try {
      const { summary, failed } = await reconcileTenantAvailability({
        supabase,
        userId: tenant.id,
        apiKey: tenant.zenbooker_api_key,
        dryRun: !apply,
        lookaheadDays,
        probeDurationMin,
        perProviderDelayMs,
        zbFetchFn: zbFetch,
        logger,
      });
      if (failed) {
        tickSummary.tenantFailures += 1;
        continue;
      }
      tickSummary.tenantsProcessed += 1;
      for (const k of Object.keys(tickSummary.totals)) {
        if (typeof summary[k] === 'number') tickSummary.totals[k] += summary[k];
      }
    } catch (e) {
      tickSummary.tenantFailures += 1;
      logger.error(
        `[ZBAvailabilityReconcileCron] tenant userId=${tenant.id} failed: ${e.message || e}`
      );
    }
  }

  logger.log(
    `[ZBAvailabilityReconcileCron] tick complete — ${JSON.stringify(tickSummary)}`
  );
  return tickSummary;
}

function startAvailabilityReconcileCron({ supabase, logger = console }) {
  if (!ENABLED()) {
    logger.log('[ZBAvailabilityReconcileCron] ZB_AVAIL_RECONCILE_ENABLED is not true — cron not started');
    return { started: false, reason: 'disabled' };
  }
  const intervalMs = INTERVAL_MS();
  logger.log(
    `[ZBAvailabilityReconcileCron] starting — interval=${intervalMs}ms apply=${APPLY()} ` +
    `lookahead=${LOOKAHEAD_DAYS()}d probeDuration=${PROBE_DURATION_MIN()}m`
  );

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runReconcileTick({ supabase, logger });
    } catch (e) {
      logger.error(`[ZBAvailabilityReconcileCron] uncaught tick error: ${e.message || e}`);
    } finally {
      running = false;
    }
  };

  const startupDelayMs = 90_000;
  const startupTimer = setTimeout(tick, startupDelayMs);
  startupTimer.unref?.();

  const interval = setInterval(tick, intervalMs);
  interval.unref?.();

  return {
    started: true,
    intervalMs,
    stop: () => { clearInterval(interval); clearTimeout(startupTimer); },
  };
}

module.exports = {
  startAvailabilityReconcileCron,
  runReconcileTick,
  zbFetch,
  ENABLED,
  APPLY,
};
