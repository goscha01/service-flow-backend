'use strict';

const {
  buildAvailabilityFromZb,
  mapRecurringHoursToWeekly,
  mapDateOverridesToCustomAvailability,
  mergeCustomAvailability,
  ZB_SOURCE_MARKER,
} = require('../lib/zenbooker-team-availability');

describe('mapRecurringHoursToWeekly', () => {
  test('maps ZB day 0..6 to sunday..saturday keys', () => {
    const zb = [
      { day: 0, hours: [{ start: '10:00', end: '14:00' }] },
      { day: 1, hours: [{ start: '09:00', end: '17:00' }] },
      { day: 6, hours: [{ start: '08:00', end: '12:00' }] },
    ];
    const w = mapRecurringHoursToWeekly(zb);
    expect(w.sunday).toEqual({ start: '10:00', end: '14:00' });
    expect(w.monday).toEqual({ start: '09:00', end: '17:00' });
    expect(w.saturday).toEqual({ start: '08:00', end: '12:00' });
  });

  test('empty hours[] on a day → { available: false }', () => {
    const w = mapRecurringHoursToWeekly([
      { day: 1, hours: [] },
      { day: 2, hours: [{ start: '09:00', end: '17:00' }] },
    ]);
    expect(w.monday).toEqual({ available: false });
    expect(w.tuesday).toEqual({ start: '09:00', end: '17:00' });
  });

  test('days missing from recurring_hours default to { available: false }', () => {
    const w = mapRecurringHoursToWeekly([
      { day: 1, hours: [{ start: '09:00', end: '17:00' }] },
    ]);
    expect(w.monday).toEqual({ start: '09:00', end: '17:00' });
    expect(w.sunday).toEqual({ available: false });
    expect(w.saturday).toEqual({ available: false });
  });

  test('multi-block days use hours: [...] shape', () => {
    const w = mapRecurringHoursToWeekly([
      { day: 3, hours: [
        { start: '08:00', end: '12:00' },
        { start: '13:00', end: '17:00' },
      ]},
    ]);
    expect(w.wednesday).toEqual({
      hours: [
        { start: '08:00', end: '12:00' },
        { start: '13:00', end: '17:00' },
      ],
    });
  });

  test('invalid day indices are ignored', () => {
    const w = mapRecurringHoursToWeekly([
      { day: 7, hours: [{ start: '09:00', end: '17:00' }] },
      { day: -1, hours: [{ start: '09:00', end: '17:00' }] },
      { day: 'monday', hours: [{ start: '09:00', end: '17:00' }] },
    ]);
    for (const name of ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']) {
      expect(w[name]).toEqual({ available: false });
    }
  });

  test('non-array input → all days marked unavailable', () => {
    const w = mapRecurringHoursToWeekly(null);
    for (const name of ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']) {
      expect(w[name]).toEqual({ available: false });
    }
  });
});

describe('mapDateOverridesToCustomAvailability', () => {
  test('hours:[] → available:false with zenbooker source', () => {
    const out = mapDateOverridesToCustomAvailability([
      { date: '2026-08-14', hours: [] },
    ]);
    expect(out).toEqual([
      { date: '2026-08-14', available: false, source: 'zenbooker' },
    ]);
  });

  test('single block → hours: [{start,end}]', () => {
    const out = mapDateOverridesToCustomAvailability([
      { date: '2026-08-15', hours: [{ start: '10:00', end: '14:00' }] },
    ]);
    expect(out[0]).toEqual({
      date: '2026-08-15',
      available: true,
      hours: [{ start: '10:00', end: '14:00' }],
      source: 'zenbooker',
    });
  });

  test('multi-block override → hours: [{start,end}, {start,end}]', () => {
    const out = mapDateOverridesToCustomAvailability([
      { date: '2026-08-16', hours: [
        { start: '08:00', end: '11:00' },
        { start: '14:00', end: '17:00' },
      ]},
    ]);
    expect(out[0].hours).toHaveLength(2);
  });

  test('invalid date format skipped', () => {
    const out = mapDateOverridesToCustomAvailability([
      { date: 'not-a-date', hours: [] },
      { date: '2026-08-14', hours: [] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-08-14');
  });

  test('sorted ascending by date', () => {
    const out = mapDateOverridesToCustomAvailability([
      { date: '2026-08-20', hours: [] },
      { date: '2026-08-15', hours: [] },
      { date: '2026-08-17', hours: [] },
    ]);
    expect(out.map(o => o.date)).toEqual(['2026-08-15', '2026-08-17', '2026-08-20']);
  });
});

describe('mergeCustomAvailability', () => {
  test('preserves manual entries and appends ZB', () => {
    const existing = [{ date: '2026-08-01', available: false }];
    const zbNew = [
      { date: '2026-08-14', available: false, source: 'zenbooker' },
    ];
    const merged = mergeCustomAvailability(existing, zbNew);
    expect(merged).toHaveLength(2);
    expect(merged.find(e => e.date === '2026-08-01').source).toBeUndefined();
    expect(merged.find(e => e.date === '2026-08-14').source).toBe('zenbooker');
  });

  test('manual entry on same date beats ZB', () => {
    const existing = [{ date: '2026-08-14', available: true, hours: [{ start: '09:00', end: '17:00' }] }];
    const zbNew = [{ date: '2026-08-14', available: false, source: 'zenbooker' }];
    const merged = mergeCustomAvailability(existing, zbNew);
    expect(merged).toHaveLength(1);
    expect(merged[0].available).toBe(true);
    expect(merged[0].source).toBeUndefined();
  });

  test('wipes prior ZB-source entries on re-run', () => {
    const existing = [{ date: '2026-08-14', available: true, hours: [{ start: '08:00', end: '12:00' }], source: 'zenbooker' }];
    const zbNew = [{ date: '2026-08-14', available: true, hours: [{ start: '09:00', end: '17:00' }], source: 'zenbooker' }];
    const merged = mergeCustomAvailability(existing, zbNew);
    expect(merged).toHaveLength(1);
    expect(merged[0].hours[0].start).toBe('09:00');
  });
});

describe('buildAvailabilityFromZb — integration', () => {
  test('full ZB payload → weekly + customAvailability with source markers', () => {
    const zb = {
      recurring_hours: [
        { day: 1, hours: [{ start: '09:00', end: '17:00' }] },
        { day: 5, hours: [{ start: '10:00', end: '15:00' }] },
      ],
      date_overrides: [
        { date: '2026-08-14', hours: [] },
        { date: '2026-08-15', hours: [{ start: '10:00', end: '14:00' }] },
      ],
    };
    const avail = buildAvailabilityFromZb(zb);
    expect(avail.monday).toEqual({ start: '09:00', end: '17:00' });
    expect(avail.friday).toEqual({ start: '10:00', end: '15:00' });
    expect(avail.tuesday).toEqual({ available: false });
    expect(avail.customAvailability).toHaveLength(2);
    expect(avail.customAvailability.every(e => e.source === 'zenbooker')).toBe(true);
  });

  test('preserves manual customAvailability entries from existing row', () => {
    const zb = {
      recurring_hours: [{ day: 1, hours: [{ start: '09:00', end: '17:00' }] }],
      date_overrides: [{ date: '2026-08-14', hours: [] }],
    };
    const existing = {
      customAvailability: [{ date: '2026-09-01', available: false }],
    };
    const avail = buildAvailabilityFromZb(zb, existing);
    const manual = avail.customAvailability.find(e => e.date === '2026-09-01');
    expect(manual).toBeDefined();
    expect(manual.source).toBeUndefined();
    const zbEntry = avail.customAvailability.find(e => e.date === '2026-08-14');
    expect(zbEntry.source).toBe('zenbooker');
  });

  test('null when ZB provides neither field (no signal)', () => {
    expect(buildAvailabilityFromZb({})).toBeNull();
    expect(buildAvailabilityFromZb({ recurring_hours: null, date_overrides: null })).toBeNull();
  });

  test('overrides-only payload preserves existing weekly keys', () => {
    const zb = {
      date_overrides: [{ date: '2026-08-14', hours: [] }],
    };
    const existing = {
      monday: { start: '08:00', end: '16:00' },
      wednesday: { start: '10:00', end: '18:00' },
      customAvailability: [],
    };
    const avail = buildAvailabilityFromZb(zb, existing);
    expect(avail.monday).toEqual({ start: '08:00', end: '16:00' });
    expect(avail.wednesday).toEqual({ start: '10:00', end: '18:00' });
    expect(avail.customAvailability).toHaveLength(1);
  });

  test('recurring-hours-only payload wipes prior weekly, sets customAvailability from existing manuals only', () => {
    const zb = {
      recurring_hours: [{ day: 1, hours: [{ start: '09:00', end: '17:00' }] }],
    };
    const existing = {
      monday: { start: '08:00', end: '16:00' },
      tuesday: { start: '10:00', end: '18:00' },
      customAvailability: [
        { date: '2026-09-01', available: false },
        { date: '2026-09-15', available: true, hours: [{ start: '10:00', end: '14:00' }], source: 'zenbooker' },
      ],
    };
    const avail = buildAvailabilityFromZb(zb, existing);
    // Weekly fully replaced — Tuesday is now { available: false } because ZB
    // didn't include it, not the prior manual entry.
    expect(avail.monday).toEqual({ start: '09:00', end: '17:00' });
    expect(avail.tuesday).toEqual({ available: false });
    // Prior ZB entry gone; prior manual entry preserved.
    expect(avail.customAvailability).toHaveLength(1);
    expect(avail.customAvailability[0].date).toBe('2026-09-01');
  });
});

describe('ZB_SOURCE_MARKER export sanity', () => {
  test('is the literal "zenbooker"', () => {
    expect(ZB_SOURCE_MARKER).toBe('zenbooker');
  });
});
