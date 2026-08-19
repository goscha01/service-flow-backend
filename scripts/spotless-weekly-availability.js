'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const USER_ID = 2; // Spotless Homes Florida LLC
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function pad(n) { return String(n).padStart(2, '0'); }

function ymd(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function weekStartMonday(today) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const deltaToMon = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + deltaToMon);
  return d;
}

function blocksToString(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  return blocks.map(b => `${b.start}–${b.end}`).join(', ');
}

function resolveDay(avail, dateStr, dayName) {
  const overrides = Array.isArray(avail?.customAvailability) ? avail.customAvailability : [];
  const override = overrides.find(o => o?.date === dateStr);
  if (override) {
    if (override.available === false) return { off: true, source: 'override' };
    if (Array.isArray(override.hours) && override.hours.length > 0) {
      return { off: false, blocks: override.hours, source: 'override' };
    }
  }
  const day = avail?.[dayName];
  if (!day) return { off: true, source: 'unset' };
  if (day.available === false) return { off: true, source: 'weekly' };
  if (day.start && day.end) return { off: false, blocks: [{ start: day.start, end: day.end }], source: 'weekly' };
  if (Array.isArray(day.hours) && day.hours.length > 0) return { off: false, blocks: day.hours, source: 'weekly' };
  return { off: true, source: 'unset' };
}

function hoursDuration(blocks, brk) {
  if (!Array.isArray(blocks)) return 0;
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  let mins = 0;
  for (const b of blocks) mins += Math.max(0, toMin(b.end) - toMin(b.start));
  if (brk?.start && brk?.end && blocks.length === 1) {
    mins -= Math.max(0, toMin(brk.end) - toMin(brk.start));
  }
  return Math.max(0, mins) / 60;
}

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  {
    const { data, error } = await supabase
      .from('team_members')
      .select('id, first_name, last_name, email, is_active, status, availability')
      .eq('user_id', USER_ID)
      .order('is_active', { ascending: false })
      .order('first_name', { ascending: true });
    if (error) throw error;
    const rows = data || [];

    const today = new Date();
    const start = weekStartMonday(today);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      days.push({
        date: ymd(d),
        name: DAY_NAMES[d.getUTCDay()],
        label: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i],
      });
    }

    const header = ['Team member', 'Status', ...days.map(d => `${d.label} ${d.date.slice(5)}`), 'Total h'];
    const table = [header];

    let activeCount = 0;
    for (const r of rows) {
      const active = r.is_active && (r.status ?? 'active') === 'active';
      if (active) activeCount++;
      const avail = r.availability || null;
      const brk = avail?.break || null;

      const cells = [];
      let totalH = 0;
      for (const d of days) {
        const res = resolveDay(avail, d.date, d.name);
        if (res.off) {
          cells.push('OFF');
        } else {
          const h = hoursDuration(res.blocks, brk);
          totalH += h;
          const tag = res.source === 'override' ? '*' : '';
          cells.push(`${blocksToString(res.blocks)}${tag}`);
        }
      }
      const name = `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email || `#${r.id}`;
      table.push([name, active ? 'active' : (r.status || 'inactive'), ...cells, totalH.toFixed(1)]);
    }

    const colW = header.map((_, i) => Math.max(...table.map(row => String(row[i] ?? '').length)));
    const line = (row) => row.map((c, i) => String(c ?? '').padEnd(colW[i])).join(' | ');
    const sep = colW.map(w => '-'.repeat(w)).join('-+-');

    console.log(`\nSpotless Homes Florida LLC — team availability`);
    console.log(`Week: ${days[0].date} (Mon) → ${days[6].date} (Sun)  |  active members: ${activeCount} / ${rows.length}`);
    console.log(`* = date-specific override    OFF = not scheduled    break subtracted for single-slot days\n`);
    console.log(line(table[0]));
    console.log(sep);
    for (let i = 1; i < table.length; i++) console.log(line(table[i]));
    console.log('');
  }
})().catch(e => { console.error(e); process.exit(1); });
