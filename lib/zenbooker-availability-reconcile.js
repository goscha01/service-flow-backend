'use strict';

/**
 * ZB → SF team-member availability reconciliation.
 *
 * ZB does not expose per-provider availability directly. But /timeslots
 * returns bookable windows computed from (provider weekly hours) ∩
 * (date overrides) ∩ (not already booked). Filtered by
 * service_providers=<zb_provider_id>, the response describes which slots
 * that provider could fill, per date.
 *
 * We fold the returned slots into team_members.availability.customAvailability
 * as `{ date, available: true, hours: [{ start, end }], source: 'zenbooker' }`
 * envelope entries — min slot start, max slot end per date. Dates with zero
 * returned slots are omitted (not written as available:false) so a partial
 * fetch failure cannot silently mark the cleaner unavailable everywhere.
 *
 * Merge policy: ZB-tagged entries are wiped and rewritten on each run.
 * Manual entries (any without source='zenbooker') survive; if a manual entry
 * exists for a date, it takes precedence over the ZB envelope for that date.
 *
 * The weekly schedule (availability.monday..sunday) is NOT touched — /timeslots
 * cannot round-trip a weekly template. Existing weekly hours remain the
 * fallback for dates outside the sync window.
 */

const DEFAULT_LOOKAHEAD_DAYS = 60;
const DEFAULT_PROBE_DURATION_MIN = 60;
const DEFAULT_PER_PROVIDER_DELAY_MS = 250;
const ZB_SOURCE_MARKER = 'zenbooker';

function unionSlotsByDate(responses) {
  const byDate = new Map();
  for (const r of responses || []) {
    for (const day of (r?.days || [])) {
      if (!day?.date) continue;
      const list = byDate.get(day.date) || [];
      for (const slot of (day.timeslots || [])) {
        if (!slot?.start) continue;
        list.push({ start: slot.start, end: slot.end || slot.start });
      }
      byDate.set(day.date, list);
    }
  }
  return byDate;
}

function extractHHMM(iso) {
  if (!iso) return null;
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

function buildEnvelopeEntries(byDate) {
  const entries = [];
  for (const [date, slots] of byDate.entries()) {
    if (!slots.length) continue;
    let minStart = null, maxEnd = null;
    for (const slot of slots) {
      const startHHMM = extractHHMM(slot.start);
      const endHHMM = extractHHMM(slot.end);
      if (!startHHMM || !endHHMM) continue;
      if (minStart === null || startHHMM < minStart) minStart = startHHMM;
      if (maxEnd === null || endHHMM > maxEnd) maxEnd = endHHMM;
    }
    if (!minStart || !maxEnd || maxEnd <= minStart) continue;
    entries.push({
      date,
      available: true,
      hours: [{ start: minStart, end: maxEnd }],
      source: ZB_SOURCE_MARKER,
    });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries;
}

function mergeCustomAvailability(existing, newZbEntries) {
  const existingArr = Array.isArray(existing) ? existing : [];
  const manualByDate = new Map();
  for (const e of existingArr) {
    if (e && e.source !== ZB_SOURCE_MARKER) {
      if (e.date) manualByDate.set(e.date, e);
    }
  }
  const preservedManuals = Array.from(manualByDate.values());
  const filteredNew = newZbEntries.filter(e => !manualByDate.has(e.date));
  return [...preservedManuals, ...filteredNew].sort((a, b) =>
    (a.date || '').localeCompare(b.date || '')
  );
}

function normalizeSfTerritoryIds(territories) {
  if (!territories) return [];
  let arr = territories;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map(x => Number(x)).filter(n => Number.isFinite(n));
}

function shallowEqualEntries(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

async function fetchTimeslotsAcrossTerritories({
  zbFetchFn,
  apiKey,
  zbProviderId,
  zbTerritoryIds,
  days,
  duration,
  logger,
}) {
  const responses = [];
  let anyAttempted = false;
  for (const zbTerritoryId of zbTerritoryIds) {
    anyAttempted = true;
    try {
      const res = await zbFetchFn(apiKey, '/timeslots', {
        territory: zbTerritoryId,
        service_providers: zbProviderId,
        days,
        duration,
      });
      if (res && Array.isArray(res.days)) responses.push(res);
    } catch (err) {
      logger?.warn?.(
        `[ZBAvailabilityReconcile] provider=${zbProviderId} territory=${zbTerritoryId} ` +
        `/timeslots failed: ${err.message || err}`
      );
    }
  }
  return { responses, anyAttempted };
}

async function reconcileTeamMemberAvailability({
  supabase,
  teamMember,
  territoriesLookup,
  apiKey,
  dryRun = true,
  lookaheadDays = DEFAULT_LOOKAHEAD_DAYS,
  probeDurationMin = DEFAULT_PROBE_DURATION_MIN,
  zbFetchFn,
  logger = console,
}) {
  if (!teamMember?.id) return { action: 'skipped', reason: 'no_team_member' };
  if (!teamMember.zenbooker_id) {
    return { action: 'skipped_no_zb_id', reason: 'team_member.zenbooker_id null' };
  }

  const sfTerritoryIds = normalizeSfTerritoryIds(teamMember.territories);
  const zbTerritoryIds = sfTerritoryIds
    .map(id => territoriesLookup.get(id)?.zenbooker_id)
    .filter(Boolean);

  if (zbTerritoryIds.length === 0) {
    return { action: 'skipped_no_territories', reason: 'no ZB-linked territories for member' };
  }

  const { responses, anyAttempted } = await fetchTimeslotsAcrossTerritories({
    zbFetchFn,
    apiKey,
    zbProviderId: teamMember.zenbooker_id,
    zbTerritoryIds,
    days: lookaheadDays,
    duration: probeDurationMin,
    logger,
  });

  if (anyAttempted && responses.length === 0) {
    return { action: 'skipped_fetch_failed', reason: 'all /timeslots calls failed' };
  }

  const byDate = unionSlotsByDate(responses);
  const newZbEntries = buildEnvelopeEntries(byDate);

  const existingAvail = (teamMember.availability && typeof teamMember.availability === 'object')
    ? teamMember.availability : {};
  const existingCustom = Array.isArray(existingAvail.customAvailability)
    ? existingAvail.customAvailability : [];
  const mergedCustom = mergeCustomAvailability(existingCustom, newZbEntries);

  if (shallowEqualEntries(existingCustom, mergedCustom)) {
    return {
      action: 'no_change',
      reason: 'customAvailability unchanged',
      datesWritten: 0,
    };
  }

  if (dryRun) {
    logger?.log?.(
      `[ZBAvailabilityReconcile] DRY-RUN userId=${teamMember.user_id} ` +
      `teamMemberId=${teamMember.id} zbProviderId=${teamMember.zenbooker_id} ` +
      `wouldWrite=${newZbEntries.length}`
    );
    return {
      action: 'would_write',
      datesWritten: newZbEntries.length,
      newEntries: newZbEntries,
    };
  }

  const nextAvail = { ...existingAvail, customAvailability: mergedCustom };
  const { error } = await supabase
    .from('team_members')
    .update({ availability: nextAvail })
    .eq('id', teamMember.id);
  if (error) {
    return { action: 'failed', reason: `update error: ${error.message}` };
  }

  logger?.log?.(
    `[ZBAvailabilityReconcile] APPLY userId=${teamMember.user_id} ` +
    `teamMemberId=${teamMember.id} datesWritten=${newZbEntries.length}`
  );
  return { action: 'written', datesWritten: newZbEntries.length };
}

async function reconcileTenantAvailability({
  supabase,
  userId,
  apiKey,
  dryRun = true,
  lookaheadDays = DEFAULT_LOOKAHEAD_DAYS,
  probeDurationMin = DEFAULT_PROBE_DURATION_MIN,
  perProviderDelayMs = DEFAULT_PER_PROVIDER_DELAY_MS,
  zbFetchFn,
  logger = console,
}) {
  const summary = {
    userId,
    scanned: 0,
    written: 0,
    would_write: 0,
    no_change: 0,
    skipped_no_zb_id: 0,
    skipped_no_territories: 0,
    skipped_fetch_failed: 0,
    failures: 0,
  };

  if (!userId || !apiKey) {
    logger?.error?.('[ZBAvailabilityReconcile] userId and apiKey required');
    return { summary, failed: true };
  }

  const { data: members, error: membersErr } = await supabase
    .from('team_members')
    .select('id, user_id, zenbooker_id, territories, availability')
    .eq('user_id', userId)
    .not('zenbooker_id', 'is', null);
  if (membersErr) {
    logger?.error?.(
      `[ZBAvailabilityReconcile] userId=${userId} team_members query error: ${membersErr.message}`
    );
    return { summary, failed: true };
  }

  const { data: terrs, error: terrErr } = await supabase
    .from('territories')
    .select('id, zenbooker_id')
    .eq('user_id', userId)
    .not('zenbooker_id', 'is', null);
  if (terrErr) {
    logger?.error?.(
      `[ZBAvailabilityReconcile] userId=${userId} territories query error: ${terrErr.message}`
    );
    return { summary, failed: true };
  }
  const territoriesLookup = new Map((terrs || []).map(t => [Number(t.id), t]));

  summary.scanned = (members || []).length;
  logger?.log?.(
    `[ZBAvailabilityReconcile] userId=${userId} scanning ${summary.scanned} ZB-linked team_members ` +
    `dryRun=${dryRun}`
  );

  for (const tm of (members || [])) {
    try {
      const result = await reconcileTeamMemberAvailability({
        supabase,
        teamMember: tm,
        territoriesLookup,
        apiKey,
        dryRun,
        lookaheadDays,
        probeDurationMin,
        zbFetchFn,
        logger,
      });
      const key = result.action;
      if (key in summary) summary[key] += 1;
      else if (key === 'failed') summary.failures += 1;
    } catch (err) {
      summary.failures += 1;
      logger?.error?.(
        `[ZBAvailabilityReconcile] userId=${userId} teamMemberId=${tm.id} unexpected: ${err.message || err}`
      );
    }
    if (perProviderDelayMs > 0) await new Promise(r => setTimeout(r, perProviderDelayMs));
  }

  logger?.log?.(`[ZBAvailabilityReconcile] userId=${userId} SUMMARY ${JSON.stringify(summary)}`);
  return { summary };
}

module.exports = {
  reconcileTeamMemberAvailability,
  reconcileTenantAvailability,
  unionSlotsByDate,
  buildEnvelopeEntries,
  mergeCustomAvailability,
  extractHHMM,
  normalizeSfTerritoryIds,
  ZB_SOURCE_MARKER,
  DEFAULT_LOOKAHEAD_DAYS,
  DEFAULT_PROBE_DURATION_MIN,
};
