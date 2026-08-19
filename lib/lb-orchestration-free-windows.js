'use strict';

/**
 * LB orchestration — per-cleaner free-windows computation.
 *
 * Feeds `GET /orchestration/team-free-windows` (Aug 2026 — added to close
 * the gap where LB's booking-availability grid never saw actual booked
 * jobs subtracted per cleaner, so operators saw shift envelopes like
 * 09:00–18:00 for a cleaner who was already double-booked).
 *
 * The default /orchestration/busy?mode=jobs path returns raw job intervals
 * (LB unions them into a "don't offer here" mask). mode=capacity aggregates
 * to territory-level AM/PM. Neither surfaces PER-CLEANER remaining free
 * time — which is what the LB booking-availability grid actually needs to
 * filter its half-day slots correctly in multi-cleaner tenants.
 *
 * Semantics (pure):
 *   free[cleaner][date] = shift(cleaner, date) − ⋃ jobs(cleaner, date)
 *
 * where:
 *   shift(cleaner, date) = getWorkingIntervals(availability, date)
 *     (customAvailability override wins over weekly[dayName])
 *   jobs(cleaner, date)  = the [start,end] minute-of-day intervals for
 *     non-cancelled jobs assigned to that cleaner on that date
 *
 * Filtering (applied by caller before invoking this module):
 *   - `is_service_provider = true` — managers/owners are excluded, they
 *     aren't bookable. Preference recorded 2026-08 by operator.
 *   - status active, is_active true
 *   - assignees resolved via job_team_assignments UNION jobs.team_member_id
 *     (matches frontend `assigneesFor` in schedule-v2.jsx and the busy
 *     handler's capacity branch)
 *
 * Not a scheduling engine. No travel time, no skills matching, no
 * territory logic — those live upstream (LB) or in the request-time
 * findAvailableSlots path.
 */

const {
  getWorkingIntervals,
  subtractIntervals,
  enumerateDates,
  jobIntervalOnDate,
} = require('./lb-orchestration-capacity');

function pad2(n) { return String(n).padStart(2, '0'); }
function minToHHMM(m) { return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`; }

/**
 * Pure: compute per-cleaner per-date free windows for a range.
 *
 * @param {Object} args
 * @param {Array<{ id, first_name, last_name, email, availability }>} args.cleaners
 *   — already filtered by caller to service providers only
 * @param {Map<string, Map<number, Array<[start,end]>>>} args.jobsByDateByCleaner
 *   — date (YYYY-MM-DD) → cleanerId → sorted [startMin,endMin] intervals
 * @param {Array<string>} args.dates  — YYYY-MM-DD strings, in range order
 * @returns {Array<{
 *   team_member_id: number,
 *   name: string,
 *   days: Array<{
 *     date: string,
 *     shift_minutes: number,
 *     free_minutes: number,
 *     free_windows: Array<{ start: string, end: string }>,  // "HH:MM" wall-clock
 *     off: boolean,                                          // no shift at all
 *   }>,
 *   totals: { shift_minutes: number, free_minutes: number },
 * }>}
 */
function computeTeamFreeWindows({ cleaners, jobsByDateByCleaner, dates }) {
  const out = [];
  for (const c of cleaners) {
    const cid = Number(c.id);
    const days = [];
    let totalShift = 0;
    let totalFree = 0;
    for (const date of dates) {
      const shift = getWorkingIntervals(c.availability, date);
      const jobs = (jobsByDateByCleaner.get(date)?.get(cid) || [])
        .slice()
        .sort((a, b) => a[0] - b[0]);
      if (!shift || shift.length === 0) {
        days.push({ date, shift_minutes: 0, free_minutes: 0, free_windows: [], off: true });
        continue;
      }
      const shiftMin = shift.reduce((s, [a, b]) => s + (b - a), 0);
      const free = subtractIntervals(shift, jobs);
      const freeMin = free.reduce((s, [a, b]) => s + (b - a), 0);
      totalShift += shiftMin;
      totalFree += freeMin;
      days.push({
        date,
        shift_minutes: shiftMin,
        free_minutes: freeMin,
        free_windows: free.map(([a, b]) => ({ start: minToHHMM(a), end: minToHHMM(b) })),
        off: false,
      });
    }
    const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.email || `#${cid}`;
    out.push({
      team_member_id: cid,
      name,
      days,
      totals: { shift_minutes: totalShift, free_minutes: totalFree },
    });
  }
  return out;
}

module.exports = {
  computeTeamFreeWindows,
  // re-exported so handler + tests don't reach into capacity module directly
  enumerateDates,
  jobIntervalOnDate,
};
