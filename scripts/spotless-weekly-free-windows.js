'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const USER_ID = 2; // Spotless Homes Florida LLC
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function toMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); }
function fromMin(m) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }

function weekStartMonday(today) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const dow = d.getUTCDay();
  const deltaToMon = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + deltaToMon);
  return d;
}

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

function fmtBlocks(blocks) {
  if (!blocks.length) return '—';
  return blocks.map(b => `${fromMin(b.start)}–${fromMin(b.end)}`).join(', ');
}

function hoursOf(blocks) {
  return blocks.reduce((s, b) => s + Math.max(0, b.end - b.start), 0) / 60;
}

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // team members
  const { data: tms, error: tmErr } = await supabase
    .from('team_members')
    .select('id, first_name, last_name, email, is_active, status, availability')
    .eq('user_id', USER_ID);
  if (tmErr) throw tmErr;

  const today = new Date();
  const start = weekStartMonday(today);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setUTCDate(start.getUTCDate() + i);
    days.push({ date: ymd(d), name: DAY_NAMES[d.getUTCDay()], label: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i] });
  }
  const weekStartYmd = days[0].date;
  const weekEndYmd = days[6].date;
  const dayAfterEnd = new Date(start); dayAfterEnd.setUTCDate(start.getUTCDate() + 7);
  const boundYmd = ymd(dayAfterEnd);

  // jobs in week — scheduled_date is TEXT storing "YYYY-MM-DD[ HH:MM:SS]"
  const { data: jobs, error: jErr } = await supabase
    .from('jobs')
    .select('id, team_member_id, scheduled_date, scheduled_time, duration, status')
    .eq('user_id', USER_ID)
    .gte('scheduled_date', weekStartYmd)
    .lt('scheduled_date', boundYmd);
  if (jErr) throw jErr;

  // job_team_assignments for those jobs
  const jobIds = jobs.map(j => j.id);
  let assignments = [];
  if (jobIds.length) {
    const { data, error } = await supabase
      .from('job_team_assignments')
      .select('job_id, team_member_id')
      .in('job_id', jobIds);
    if (error) throw error;
    assignments = data || [];
  }
  const assigneesByJob = new Map();
  for (const a of assignments) {
    if (!assigneesByJob.has(a.job_id)) assigneesByJob.set(a.job_id, new Set());
    assigneesByJob.get(a.job_id).add(a.team_member_id);
  }

  // build busy map: tmId -> date -> [ {start,end} ]
  const busy = new Map();
  const addBusy = (tmId, date, block) => {
    if (!busy.has(tmId)) busy.set(tmId, new Map());
    const dm = busy.get(tmId);
    if (!dm.has(date)) dm.set(date, []);
    dm.get(date).push(block);
  };
  for (const j of jobs) {
    const s = String(j.status || '').toLowerCase();
    if (s === 'cancelled' || s === 'canceled') continue;
    if (!j.scheduled_date) continue;
    // scheduled_date is TEXT "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS" (real start time)
    // scheduled_time is a fallback used only when scheduled_date has no time part
    const m = String(j.scheduled_date).match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/);
    if (!m) continue;
    const dateKey = m[1];
    const timeStr = m[2] || j.scheduled_time;
    if (!timeStr) continue;
    const startMin = toMin(timeStr);
    const dur = Number.isFinite(+j.duration) && +j.duration > 0 ? +j.duration : 60;
    const block = { start: startMin, end: startMin + dur };
    const set = assigneesByJob.get(j.id) || new Set();
    if (set.size === 0 && j.team_member_id) set.add(j.team_member_id);
    for (const tmId of set) addBusy(tmId, dateKey, block);
  }

  const activeReal = tms.filter(t =>
    t.is_active && (t.status ?? 'active') === 'active' &&
    !/test/i.test(`${t.first_name || ''} ${t.last_name || ''}`)
  );

  const rows = [];
  for (const t of activeReal) {
    const name = `${t.first_name || ''} ${t.last_name || ''}`.trim() || t.email || `#${t.id}`;
    const dm = busy.get(t.id) || new Map();
    const cells = [];
    let freeH = 0;
    let shiftH = 0;
    for (const d of days) {
      const shift = shiftBlocksFor(t.availability, d.date, d.name);
      const jobsToday = (dm.get(d.date) || []).sort((a, b) => a.start - b.start);
      shiftH += hoursOf(shift);
      if (!shift.length) { cells.push({ text: 'OFF', kind: 'off' }); continue; }
      const free = subtractBusy(shift, jobsToday);
      const h = hoursOf(free);
      freeH += h;
      cells.push({ text: fmtBlocks(free), kind: free.length ? 'free' : 'full', h });
    }
    rows.push({ name, id: t.id, cells, freeH, shiftH });
  }

  // sort: least free first
  rows.sort((a, b) => a.freeH - b.freeH);

  const header = ['Team member', ...days.map(d => `${d.label} ${d.date.slice(5)}`), 'Free h', 'Shift h'];
  const table = [header, ...rows.map(r => [r.name, ...r.cells.map(c => c.text), r.freeH.toFixed(1), r.shiftH.toFixed(1)])];
  const colW = header.map((_, i) => Math.max(...table.map(row => String(row[i] ?? '').length)));
  const line = (row) => row.map((c, i) => String(c ?? '').padEnd(colW[i])).join(' | ');
  const sep = colW.map(w => '-'.repeat(w)).join('-+-');

  console.log(`\nSpotless Homes Florida LLC — free windows (shift minus non-cancelled jobs)`);
  console.log(`Week: ${weekStartYmd} (Mon) → ${weekEndYmd} (Sun)  |  active real staff: ${activeReal.length}  |  jobs in window: ${jobs.length}`);
  console.log(`OFF = not on shift    — = fully booked    ranges = actual free windows\n`);
  console.log(line(table[0]));
  console.log(sep);
  for (let i = 1; i < table.length; i++) console.log(line(table[i]));
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
