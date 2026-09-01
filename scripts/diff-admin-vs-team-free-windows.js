'use strict';

/**
 * Diff-zero verifier for the 2026-08-20 availability audit.
 *
 * Runs BOTH per-cleaner free-window calculation paths against real
 * Supabase for the same tenant + week and asserts row-for-row equality.
 *
 *   Path A: admin path — direct DB query with the same primitives the
 *           admin Team Availability grid uses (scheduled_date + duration,
 *           no end_time, tenant-wide job pull).
 *   Path B: /team-free-windows handler — invoked in-process via
 *           makeTeamFreeWindowsHandler, hits the same Supabase.
 *
 * Post-fix both should be identical. Pre-fix, path B was over-subtracting
 * by ~4–7h/cleaner/week because it read `end_time` (which stores the
 * clock-out timestamp, not the scheduled end). See commit note for the
 * full root cause.
 *
 * Usage:
 *   USER_ID=2 WEEK_START=2026-08-17 node scripts/diff-admin-vs-team-free-windows.js
 *
 * Env fallback: user_id=2 (Spotless Homes Florida LLC), week starts on
 * the Monday containing today. Non-zero exit on any diff.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const {
  makeTeamFreeWindowsHandler,
} = require('../lib/lb-orchestration-handlers');

const USER_ID = Number(process.env.USER_ID || 2);
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MANAGER_ROLES = new Set(['account owner', 'owner', 'admin', 'manager', 'scheduler']);

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function weekStartMonday(today) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d;
}

// ─── Admin path (direct DB) ──────────────────────────────────────────
// Same logic the admin Team Availability grid + scripts/spotless-weekly-
// free-windows.js use. NEVER reads end_time.
function toMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); }
function shiftBlocksFor(avail, dateStr, dayName) {
  const overrides = Array.isArray(avail?.customAvailability) ? avail.customAvailability : [];
  const override = overrides.find(o => o?.date === dateStr);
  if (override) {
    if (override.available === false) return [];
    if (Array.isArray(override.hours) && override.hours.length) {
      return override.hours.map(h => ({ start: toMin(h.start), end: toMin(h.end) }));
    }
  }
  const day = avail?.[dayName];
  if (!day || day.available === false) return [];
  if (day.start && day.end) return [{ start: toMin(day.start), end: toMin(day.end) }];
  if (Array.isArray(day.hours) && day.hours.length) return day.hours.map(h => ({ start: toMin(h.start), end: toMin(h.end) }));
  return [];
}
function subtractBusy(shiftBlocks, busyBlocks) {
  let free = shiftBlocks.map(b => ({ ...b }));
  for (const b of busyBlocks) {
    const next = [];
    for (const s of free) {
      if (b.end <= s.start || b.start >= s.end) { next.push(s); continue; }
      if (b.start > s.start) next.push({ start: s.start, end: Math.min(s.end, b.start) });
      if (b.end < s.end) next.push({ start: Math.max(s.start, b.end), end: s.end });
    }
    free = next.filter(s => s.end - s.start > 0);
  }
  return free;
}

async function adminPath(supabase, weekStart) {
  const { data: tms } = await supabase
    .from('team_members')
    .select('id, first_name, last_name, availability, is_active, status, is_service_provider, role')
    .eq('user_id', USER_ID);
  const active = (tms || []).filter(t =>
    t.is_active && (t.status ?? 'active') === 'active' &&
    t.is_service_provider === true &&
    !MANAGER_ROLES.has(String(t.role || '').toLowerCase())
  );
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart); d.setUTCDate(weekStart.getUTCDate() + i);
    days.push({ date: ymd(d), name: DAY_NAMES[d.getUTCDay()] });
  }
  const dayAfterEnd = new Date(weekStart); dayAfterEnd.setUTCDate(weekStart.getUTCDate() + 7);
  const { data: jobs } = await supabase
    .from('jobs')
    .select('id, team_member_id, scheduled_date, duration, status, job_team_assignments(team_member_id)')
    .eq('user_id', USER_ID)
    .gte('scheduled_date', days[0].date)
    .lt('scheduled_date', ymd(dayAfterEnd));

  const busy = new Map(); // tmId -> date -> [{start,end}]
  for (const j of jobs || []) {
    if (String(j.status || '').toLowerCase() === 'cancelled') continue;
    const m = String(j.scheduled_date || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?/);
    if (!m || !m[2]) continue;
    const dateKey = m[1];
    const startMin = Number(m[2]) * 60 + Number(m[3]);
    const dur = Number(j.duration) > 0 ? Number(j.duration) : 60;
    const block = { start: startMin, end: startMin + dur };
    const set = new Set();
    if (Array.isArray(j.job_team_assignments)) for (const a of j.job_team_assignments) if (a?.team_member_id != null) set.add(Number(a.team_member_id));
    if (set.size === 0 && j.team_member_id != null) set.add(Number(j.team_member_id));
    for (const tmId of set) {
      if (!busy.has(tmId)) busy.set(tmId, new Map());
      if (!busy.get(tmId).has(dateKey)) busy.get(tmId).set(dateKey, []);
      busy.get(tmId).get(dateKey).push(block);
    }
  }

  const out = new Map(); // tmId -> {name, days: {date: [{start,end}]}}
  for (const t of active) {
    const name = `${t.first_name || ''} ${t.last_name || ''}`.trim() || `#${t.id}`;
    const perDay = {};
    for (const d of days) {
      const shift = shiftBlocksFor(t.availability, d.date, d.name);
      const jobsToday = (busy.get(t.id)?.get(d.date) || []).sort((a, b) => a.start - b.start);
      perDay[d.date] = subtractBusy(shift, jobsToday);
    }
    out.set(Number(t.id), { name, days: perDay });
  }
  return { days, out };
}

// ─── Handler path (in-process) ───────────────────────────────────────
async function handlerPath(supabase, weekStart, endStr) {
  const handler = makeTeamFreeWindowsHandler({ supabase, logger: { log() {}, warn() {}, error() {} } });
  const req = { user: { userId: USER_ID }, query: { from: `${ymd(weekStart)}T00:00:00`, to: `${endStr}T23:59:00` } };
  const res = { _body: null, _status: 200, status(c) { this._status = c; return this; }, json(b) { this._body = b; return this; } };
  await handler(req, res);
  if (res._status !== 200) throw new Error(`handler returned ${res._status}: ${JSON.stringify(res._body)}`);
  const out = new Map();
  for (const t of res._body.team) {
    const perDay = {};
    for (const d of t.days) {
      perDay[d.date] = d.free_windows.map(w => ({ start: toMin(w.start), end: toMin(w.end) }));
    }
    out.set(Number(t.team_member_id), { name: t.name, days: perDay });
  }
  return out;
}

function windowsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end) return false;
  }
  return true;
}
function fmtBlocks(blocks) {
  return blocks.length === 0 ? '—' : blocks.map(b => `${pad(Math.floor(b.start / 60))}:${pad(b.start % 60)}-${pad(Math.floor(b.end / 60))}:${pad(b.end % 60)}`).join(', ');
}

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const weekStart = process.env.WEEK_START
    ? new Date(`${process.env.WEEK_START}T00:00:00Z`)
    : weekStartMonday(new Date());
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart); d.setUTCDate(weekStart.getUTCDate() + i);
    days.push(ymd(d));
  }
  console.log(`Diff run — user_id=${USER_ID} week=${days[0]}..${days[6]}\n`);

  const [adminResult, handlerMap] = await Promise.all([
    adminPath(supabase, weekStart),
    handlerPath(supabase, weekStart, days[6]),
  ]);

  let mismatches = 0;
  let matched = 0;
  const allIds = new Set([...adminResult.out.keys(), ...handlerMap.keys()]);
  for (const id of [...allIds].sort((a, b) => a - b)) {
    const adminRow = adminResult.out.get(id);
    const handlerRow = handlerMap.get(id);
    if (!adminRow || !handlerRow) {
      console.log(`MISSING id=${id} adminOnly=${!!adminRow} handlerOnly=${!!handlerRow}`);
      mismatches++;
      continue;
    }
    for (const date of days) {
      const a = adminRow.days[date] || [];
      const h = handlerRow.days[date] || [];
      if (!windowsEqual(a, h)) {
        console.log(`DIFF id=${id} ${adminRow.name}  date=${date}`);
        console.log(`  admin  : ${fmtBlocks(a)}`);
        console.log(`  handler: ${fmtBlocks(h)}`);
        mismatches++;
      } else {
        matched++;
      }
    }
  }
  console.log(`\nMatched cells: ${matched}`);
  console.log(`Mismatched  : ${mismatches}`);
  if (mismatches > 0) process.exit(1);
  console.log('\n✅ DIFF ZERO — admin path and /team-free-windows handler agree row-for-row.');
})().catch(e => { console.error(e); process.exit(2); });
