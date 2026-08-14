'use strict';

/**
 * LB orchestration — capacity-mode busy computation.
 *
 * The default /orchestration/busy path treats every scheduled job as a
 * busy window: any job at the location → that half-day looks red on the
 * LB calendar, regardless of how many other cleaners at the same
 * location are free. That's fine for the AI booking path (it's a
 * conservative "don't offer over this slot" signal), but it makes the
 * operator-facing calendar wrong when a location has multiple cleaners.
 *
 * capacity mode aggregates at the TERRITORY (aka location) level and
 * emits busy windows only when NO cleaner at that territory has any
 * unbooked working minutes in the half-day.
 *
 * Rules (per Aug 2026 operator spec):
 *   AM window: 09:00–14:00  (5h)
 *   PM window: 13:00–18:00  (5h)
 *   One-hour overlap 13:00–14:00 is intentional — a job 12:00–14:00
 *   partially eats both windows; capacity is "any unbooked working
 *   minute in the window", not "the whole window free".
 *
 * A cleaner is AM-available on date D iff:
 *   1. They have working hours on D (per team_members.availability —
 *      customAvailability wins, else weekly[dayName]).
 *   2. Their working intervals ∩ [09:00, 14:00] minus their booked
 *      intervals on D still has ≥1 minute remaining.
 *
 * A territory is AM-busy on D iff no cleaner assigned to it is AM-
 * available. Same for PM.
 *
 * Everything here is pure — no I/O, no logger dependency. The handler
 * layer feeds it (cleaner list + availability, jobs list) and consumes
 * the returned busy_windows.
 */

const AM_START_MIN = 9 * 60;   // 09:00
const AM_END_MIN   = 14 * 60;  // 14:00
const PM_START_MIN = 13 * 60;  // 13:00
const PM_END_MIN   = 18 * 60;  // 18:00

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseHHMMToMin(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function dayNameFromDateString(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(d.getTime())) return null;
  return DAY_NAMES[d.getDay()];
}

function normalizeEntryToBlocks(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.available === false) return [];
  if (Array.isArray(entry.hours) && entry.hours.length > 0) {
    const out = [];
    for (const h of entry.hours) {
      const s = parseHHMMToMin(h?.start);
      const e = parseHHMMToMin(h?.end);
      if (s == null || e == null || e <= s) continue;
      out.push([s, e]);
    }
    return out.length > 0 ? out : null;
  }
  const s = parseHHMMToMin(entry.start);
  const e = parseHHMMToMin(entry.end);
  if (s == null || e == null || e <= s) return null;
  return [[s, e]];
}

/**
 * Pure: returns the working intervals (array of [startMin, endMin]) for
 * a cleaner on a given date. Empty array = explicitly off; null = no
 * signal (caller decides how to treat).
 */
function getWorkingIntervals(availability, dateStr) {
  if (!availability || typeof availability !== 'object') return null;
  const custom = Array.isArray(availability.customAvailability) ? availability.customAvailability : [];
  const override = custom.find(e => e && e.date === dateStr);
  if (override) {
    const blocks = normalizeEntryToBlocks(override);
    if (blocks !== null) return blocks;
  }
  const dayName = dayNameFromDateString(dateStr);
  if (!dayName) return null;
  const weekly = availability[dayName];
  if (!weekly) return null;
  return normalizeEntryToBlocks(weekly);
}

/**
 * Pure: given a list of intervals and a subtract list, return the
 * remainder (intervals in base not covered by any subtract). Both inputs
 * are [start, end] pairs in minutes-of-day; both must be sorted or will
 * be sorted internally.
 */
function subtractIntervals(base, subtract) {
  const sorted = [...(subtract || [])]
    .filter(iv => Array.isArray(iv) && iv.length === 2 && iv[1] > iv[0])
    .sort((a, b) => a[0] - b[0]);
  // Merge overlaps in subtract
  const merged = [];
  for (const iv of sorted) {
    if (merged.length && iv[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
    } else {
      merged.push([iv[0], iv[1]]);
    }
  }
  const out = [];
  for (const [bs, be] of base) {
    let cur = bs;
    for (const [ss, se] of merged) {
      if (se <= cur) continue;
      if (ss >= be) break;
      if (ss > cur) out.push([cur, Math.min(ss, be)]);
      cur = Math.max(cur, se);
      if (cur >= be) break;
    }
    if (cur < be) out.push([cur, be]);
  }
  return out;
}

function intersectsWindow(intervals, winStart, winEnd) {
  for (const [s, e] of intervals) {
    if (s < winEnd && e > winStart) return true;
  }
  return false;
}

/**
 * Compute per-cleaner AM/PM availability for a single date, given the
 * cleaner's availability jsonb and their booked-job intervals for that
 * date (already resolved to minute-of-day pairs).
 *
 * Returns { amAvailable: boolean, pmAvailable: boolean, offDay: boolean }.
 *
 * offDay = true when the cleaner has no working intervals for the date
 * at all (either explicit override with available:false, weekly gap, or
 * no availability signal). Used only for diagnostics — capacity is
 * derived from amAvailable / pmAvailable.
 */
function cleanerAvailabilityForDate({ availability, jobIntervals, dateStr }) {
  const working = getWorkingIntervals(availability, dateStr);
  if (!working || working.length === 0) {
    return { amAvailable: false, pmAvailable: false, offDay: true };
  }
  const remaining = subtractIntervals(working, jobIntervals || []);
  if (remaining.length === 0) {
    return { amAvailable: false, pmAvailable: false, offDay: false };
  }
  return {
    amAvailable: intersectsWindow(remaining, AM_START_MIN, AM_END_MIN),
    pmAvailable: intersectsWindow(remaining, PM_START_MIN, PM_END_MIN),
    offDay: false,
  };
}

/**
 * Convert an ISO datetime + duration to a [startMin, endMin] pair
 * clamped to the given day's midnight-anchored minute-of-day range.
 * Jobs that cross day boundaries are split — this returns the portion
 * that falls on `dateStr`.
 */
function jobIntervalOnDate(jobStartIso, jobEndIso, dateStr) {
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const js = new Date(jobStartIso);
  const je = new Date(jobEndIso);
  if (isNaN(js.getTime()) || isNaN(je.getTime())) return null;
  const s = Math.max(js.getTime(), dayStart.getTime());
  const e = Math.min(je.getTime(), dayEnd.getTime());
  if (e <= s) return null;
  const startMin = Math.floor((s - dayStart.getTime()) / 60000);
  const endMin = Math.ceil((e - dayStart.getTime()) / 60000);
  return [startMin, endMin];
}

/**
 * Compute capacity-mode busy windows for a territory over a date range.
 *
 * @param {Object} args
 * @param {Array<{ id, availability }>} args.cleaners  team members
 *   assigned to the territory (each with the availability jsonb)
 * @param {Map<string, Map<number, Array<[start,end]>>>} args.jobsByDateByCleaner
 *   date → cleanerId → sorted [start,end] intervals (minute-of-day)
 * @param {Array<string>} args.dates  YYYY-MM-DD strings in the range
 * @returns {Array<{ start: string, end: string }>}  ISO busy windows —
 *   emitted for AM and/or PM whenever zero cleaners are available that
 *   half-day.
 */
function computeCapacityBusyWindows({ cleaners, jobsByDateByCleaner, dates }) {
  const out = [];
  for (const date of dates) {
    let amFreeCount = 0;
    let pmFreeCount = 0;
    for (const c of cleaners) {
      const cleanerJobs = jobsByDateByCleaner.get(date)?.get(c.id) || [];
      const r = cleanerAvailabilityForDate({
        availability: c.availability,
        jobIntervals: cleanerJobs,
        dateStr: date,
      });
      if (r.amAvailable) amFreeCount++;
      if (r.pmAvailable) pmFreeCount++;
    }
    if (amFreeCount === 0) {
      out.push({
        start: `${date}T09:00:00`,
        end:   `${date}T14:00:00`,
      });
    }
    if (pmFreeCount === 0) {
      out.push({
        start: `${date}T13:00:00`,
        end:   `${date}T18:00:00`,
      });
    }
  }
  return out;
}

/**
 * Utility: enumerate YYYY-MM-DD strings between fromMs and toMs (inclusive
 * of days that overlap the range).
 */
function enumerateDates(fromMs, toMs) {
  const out = [];
  const start = new Date(fromMs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(toMs);
  end.setHours(0, 0, 0, 0);
  const cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    const y = cur.getFullYear();
    const mo = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    out.push(`${y}-${mo}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

module.exports = {
  AM_START_MIN,
  AM_END_MIN,
  PM_START_MIN,
  PM_END_MIN,
  parseHHMMToMin,
  dayNameFromDateString,
  getWorkingIntervals,
  subtractIntervals,
  cleanerAvailabilityForDate,
  jobIntervalOnDate,
  computeCapacityBusyWindows,
  enumerateDates,
};
