'use strict';

/**
 * On-demand ZB → SF availability sync (one tenant).
 *
 * Fetches ZB /team_members (cursor pagination) and, for every SF team_member
 * with a zenbooker_id, rewrites availability using recurring_hours +
 * date_overrides via buildAvailabilityFromZb. This replaces the older
 * /timeslots-based reconciler, which:
 *   - required territories (skipped ~85% of members that lack a linked
 *     ZB territory), and
 *   - could not record off-days (empty timeslot response was omitted, not
 *     written as available:false — so a manager marking a cleaner off in
 *     ZB never propagated to SF).
 *
 * date_overrides carries the off-day signal directly (`hours: []`), so the
 * new path handles Alina's "Aug 18-19 off" case that the old reconciler
 * silently dropped.
 *
 * Merge preserves manual customAvailability entries (source unset) via
 * buildAvailabilityFromZb.
 */

const { buildAvailabilityFromZb } = require('./zenbooker-team-availability');

const ZB_BASE = 'https://api.zenbooker.com/v1';
const DEFAULT_PAGE_LIMIT = 100;

async function zbFetch(apiKey, path, params = {}) {
  const url = new URL(`${ZB_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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

async function fetchAllZbTeamMembers(apiKey, { logger } = {}) {
  const all = [];
  let cursor = 0;
  while (true) {
    const data = await zbFetch(apiKey, '/team_members', { cursor, limit: DEFAULT_PAGE_LIMIT });
    if (Array.isArray(data?.results)) all.push(...data.results);
    if (!data?.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
    logger?.log?.(`[ZBAvailabilityOnlySync] paged, cursor=${cursor}, total_so_far=${all.length}`);
  }
  return all;
}

async function syncAvailabilityFromZenbooker({ supabase, userId, apiKey, logger = console, zbFetchAllFn }) {
  const summary = {
    userId,
    scanned: 0,
    updated: 0,
    unchanged: 0,
    skipped_no_zb_id: 0,
    skipped_no_zb_match: 0,
    skipped_no_signal: 0,
    failed: 0,
  };

  if (!userId || !apiKey) {
    return { summary, failed: true, reason: 'userId + apiKey required' };
  }

  const zbList = await (zbFetchAllFn || fetchAllZbTeamMembers)(apiKey, { logger });
  const zbById = new Map();
  for (const row of zbList) {
    if (row?.id) zbById.set(String(row.id), row);
  }
  logger?.log?.(
    `[ZBAvailabilityOnlySync] userId=${userId} fetched ${zbList.length} ZB team_members`
  );

  const { data: members, error: mErr } = await supabase
    .from('team_members')
    .select('id, zenbooker_id, availability')
    .eq('user_id', userId);
  if (mErr) {
    return { summary, failed: true, reason: `team_members query failed: ${mErr.message}` };
  }

  summary.scanned = (members || []).length;

  for (const tm of (members || [])) {
    try {
      if (!tm.zenbooker_id) { summary.skipped_no_zb_id += 1; continue; }
      const zb = zbById.get(String(tm.zenbooker_id));
      if (!zb) { summary.skipped_no_zb_match += 1; continue; }
      const next = buildAvailabilityFromZb(zb, tm.availability || null);
      if (!next) { summary.skipped_no_signal += 1; continue; }
      // Deep-equal check via stringify — availability payloads are small.
      if (JSON.stringify(next) === JSON.stringify(tm.availability || null)) {
        summary.unchanged += 1;
        continue;
      }
      const { error: uErr } = await supabase
        .from('team_members')
        .update({ availability: next, updated_at: new Date().toISOString() })
        .eq('id', tm.id);
      if (uErr) {
        summary.failed += 1;
        logger?.warn?.(
          `[ZBAvailabilityOnlySync] userId=${userId} team_member ${tm.id} update failed: ${uErr.message}`
        );
        continue;
      }
      summary.updated += 1;
    } catch (e) {
      summary.failed += 1;
      logger?.error?.(
        `[ZBAvailabilityOnlySync] userId=${userId} team_member ${tm.id} error: ${e.message || e}`
      );
    }
  }

  logger?.log?.(`[ZBAvailabilityOnlySync] userId=${userId} SUMMARY ${JSON.stringify(summary)}`);
  return { summary };
}

module.exports = {
  syncAvailabilityFromZenbooker,
  fetchAllZbTeamMembers,
  zbFetch,
};
