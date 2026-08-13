'use strict';

/**
 * Zenbooker → SF team_member availability mapper.
 *
 * ZB /team_members exposes `recurring_hours` (weekly template) and
 * `date_overrides` (one-off dates) directly on every provider record.
 * This is a much cleaner source of truth than the /timeslots reverse-
 * engineering I originally used for the ZBAvailabilityReconcileCron —
 * one round-trip, exact data, no envelope approximation, no 60-day cap.
 *
 * ZB shape (per developers.zenbooker.com/reference/create-a-team-member):
 *
 *   recurring_hours: [
 *     { day: 0..6 (0=Sun, 1=Mon, ... 6=Sat), hours: [{ start: "HH:mm", end: "HH:mm" }, ...] },
 *     ...
 *   ]
 *   date_overrides: [
 *     { date: "YYYY-MM-DD", hours: [{ start: "HH:mm", end: "HH:mm" }, ...] },
 *     ...
 *   ]
 *
 *   - hours: []  → unavailable that day / date
 *   - multiple blocks → split shift
 *
 * SF `team_members.availability` jsonb:
 *
 *   {
 *     monday:    { start, end }  |  { hours: [{start,end}, ...] }  |  { available: false }
 *     tuesday:   ...
 *     ...
 *     sunday:    ...
 *     customAvailability: [
 *       { date, available: true|false, hours?: [{start,end}, ...], source?: 'zenbooker' }
 *     ]
 *   }
 *
 * Merge policy (matches the earlier /timeslots reconciler):
 *   - Weekly schedule (monday..sunday) is fully replaced by ZB. Operator
 *     preference recorded 2026-08: "ZB overrides. If not connected —
 *     manual only — nothing to overwrite."
 *   - customAvailability entries with source='zenbooker' are wiped and
 *     rewritten. Manual entries (source unset) are preserved. A manual
 *     entry on the same date takes precedence over the ZB envelope.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ZB_SOURCE_MARKER = 'zenbooker';

function normalizeHours(hoursArr) {
  if (!Array.isArray(hoursArr)) return [];
  return hoursArr
    .filter(h => h && typeof h.start === 'string' && typeof h.end === 'string')
    .map(h => ({ start: h.start, end: h.end }));
}

/**
 * Pure: convert ZB recurring_hours[] → SF weekly schedule keys.
 * Returns an object shaped like:
 *   { sunday: {...}, monday: {...}, ..., saturday: {...} }
 * Days NOT present in recurring_hours are set to { available: false }
 * (explicit "no working hours this day"). Days with a single time block
 * are collapsed to the { start, end } shape SF's editor writes; multi-
 * block days use the { hours: [...] } shape the SF availability check
 * already understands.
 */
function mapRecurringHoursToWeekly(recurringHours) {
  const weekly = {};
  for (const name of DAY_NAMES) weekly[name] = { available: false };
  if (!Array.isArray(recurringHours)) return weekly;
  for (const entry of recurringHours) {
    const dayIdx = Number(entry?.day);
    if (!Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) continue;
    const name = DAY_NAMES[dayIdx];
    const blocks = normalizeHours(entry.hours);
    if (blocks.length === 0) {
      weekly[name] = { available: false };
    } else if (blocks.length === 1) {
      weekly[name] = { start: blocks[0].start, end: blocks[0].end };
    } else {
      weekly[name] = { hours: blocks };
    }
  }
  return weekly;
}

/**
 * Pure: convert ZB date_overrides[] → customAvailability entries
 * tagged with source='zenbooker'.
 */
function mapDateOverridesToCustomAvailability(dateOverrides) {
  if (!Array.isArray(dateOverrides)) return [];
  const out = [];
  for (const entry of dateOverrides) {
    const date = entry?.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const blocks = normalizeHours(entry.hours);
    if (blocks.length === 0) {
      out.push({ date, available: false, source: ZB_SOURCE_MARKER });
    } else if (blocks.length === 1) {
      out.push({
        date,
        available: true,
        hours: [{ start: blocks[0].start, end: blocks[0].end }],
        source: ZB_SOURCE_MARKER,
      });
    } else {
      out.push({
        date,
        available: true,
        hours: blocks,
        source: ZB_SOURCE_MARKER,
      });
    }
  }
  out.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return out;
}

/**
 * Pure: merge new ZB customAvailability entries into an existing array,
 * preserving manual entries and letting a same-date manual entry win.
 */
function mergeCustomAvailability(existingArr, newZbEntries) {
  const existing = Array.isArray(existingArr) ? existingArr : [];
  const manualByDate = new Map();
  for (const e of existing) {
    if (e && e.source !== ZB_SOURCE_MARKER && e.date) manualByDate.set(e.date, e);
  }
  const preservedManuals = Array.from(manualByDate.values());
  const filteredNew = newZbEntries.filter(e => !manualByDate.has(e.date));
  return [...preservedManuals, ...filteredNew].sort((a, b) =>
    (a.date || '').localeCompare(b.date || '')
  );
}

/**
 * Build the availability payload to write for one ZB team_member.
 *
 * @param {object} zb  raw ZB team_member row (must include recurring_hours,
 *                     date_overrides, or both — either may be absent)
 * @param {object} [existingAvailability]  current jsonb on the SF row (used
 *                     to preserve manual customAvailability entries)
 * @returns {object|null}  the new availability jsonb, or null when ZB
 *                     provides neither weekly hours nor overrides (no signal)
 */
function buildAvailabilityFromZb(zb, existingAvailability = null) {
  const hasRecurring = Array.isArray(zb?.recurring_hours);
  const hasOverrides = Array.isArray(zb?.date_overrides);
  if (!hasRecurring && !hasOverrides) return null;

  const weekly = hasRecurring
    ? mapRecurringHoursToWeekly(zb.recurring_hours)
    : {};

  const zbEntries = hasOverrides
    ? mapDateOverridesToCustomAvailability(zb.date_overrides)
    : [];

  const existingCustom = (existingAvailability && Array.isArray(existingAvailability.customAvailability))
    ? existingAvailability.customAvailability
    : [];
  const mergedCustom = mergeCustomAvailability(existingCustom, zbEntries);

  const next = {};
  // When ZB gives us a weekly schedule, that section fully replaces the
  // existing weekly keys. When ZB doesn't (only overrides sent), leave
  // whatever weekly keys were on the existing row.
  if (hasRecurring) {
    for (const name of DAY_NAMES) next[name] = weekly[name];
  } else if (existingAvailability && typeof existingAvailability === 'object') {
    for (const name of DAY_NAMES) {
      if (existingAvailability[name] !== undefined) next[name] = existingAvailability[name];
    }
  }
  next.customAvailability = mergedCustom;
  return next;
}

module.exports = {
  buildAvailabilityFromZb,
  mapRecurringHoursToWeekly,
  mapDateOverridesToCustomAvailability,
  mergeCustomAvailability,
  DAY_NAMES,
  ZB_SOURCE_MARKER,
};
