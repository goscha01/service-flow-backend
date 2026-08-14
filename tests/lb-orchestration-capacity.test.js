'use strict';

const {
  parseHHMMToMin,
  dayNameFromDateString,
  getWorkingIntervals,
  subtractIntervals,
  cleanerAvailabilityForDate,
  jobIntervalOnDate,
  computeCapacityBusyWindows,
  enumerateDates,
  AM_START_MIN,
  AM_END_MIN,
  PM_START_MIN,
  PM_END_MIN,
} = require('../lib/lb-orchestration-capacity');

describe('parseHHMMToMin', () => {
  test('parses HH:MM to minutes-of-day', () => {
    expect(parseHHMMToMin('09:00')).toBe(9 * 60);
    expect(parseHHMMToMin('14:30')).toBe(14 * 60 + 30);
    expect(parseHHMMToMin('00:00')).toBe(0);
  });
  test('rejects invalid', () => {
    expect(parseHHMMToMin(null)).toBeNull();
    expect(parseHHMMToMin('24:00')).toBeNull();
    expect(parseHHMMToMin('nope')).toBeNull();
  });
});

describe('dayNameFromDateString', () => {
  test('correctly resolves day-of-week', () => {
    // 2026-08-10 is a Monday
    expect(dayNameFromDateString('2026-08-10')).toBe('monday');
    expect(dayNameFromDateString('2026-08-15')).toBe('saturday');
    expect(dayNameFromDateString('2026-08-16')).toBe('sunday');
  });
});

describe('getWorkingIntervals', () => {
  const avail = {
    monday:  { start: '09:00', end: '17:00' },
    tuesday: { hours: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }] },
    wednesday: { available: false },
    customAvailability: [
      { date: '2026-08-14', available: false, source: 'zenbooker' },
      { date: '2026-08-20', available: true, hours: [{ start: '10:00', end: '15:00' }], source: 'zenbooker' },
    ],
  };

  test('weekly single-block day', () => {
    // 2026-08-10 = Monday
    expect(getWorkingIntervals(avail, '2026-08-10')).toEqual([[9*60, 17*60]]);
  });

  test('weekly multi-block day', () => {
    // 2026-08-11 = Tuesday
    expect(getWorkingIntervals(avail, '2026-08-11')).toEqual([[8*60, 12*60], [13*60, 17*60]]);
  });

  test('weekly explicit off', () => {
    // 2026-08-12 = Wednesday, available: false
    expect(getWorkingIntervals(avail, '2026-08-12')).toEqual([]);
  });

  test('customAvailability override — off wins over weekly', () => {
    expect(getWorkingIntervals(avail, '2026-08-14')).toEqual([]);
  });

  test('customAvailability override — specific hours win over weekly', () => {
    expect(getWorkingIntervals(avail, '2026-08-20')).toEqual([[10*60, 15*60]]);
  });

  test('no availability object → null', () => {
    expect(getWorkingIntervals(null, '2026-08-10')).toBeNull();
  });

  test('day missing from weekly → null (no signal)', () => {
    // Thursday not defined in avail
    expect(getWorkingIntervals(avail, '2026-08-13')).toBeNull();
  });
});

describe('subtractIntervals', () => {
  test('empty subtract returns base unchanged', () => {
    expect(subtractIntervals([[9*60, 17*60]], [])).toEqual([[9*60, 17*60]]);
  });
  test('single job splits base', () => {
    expect(subtractIntervals([[9*60, 17*60]], [[10*60, 12*60]]))
      .toEqual([[9*60, 10*60], [12*60, 17*60]]);
  });
  test('job at start', () => {
    expect(subtractIntervals([[9*60, 17*60]], [[9*60, 11*60]]))
      .toEqual([[11*60, 17*60]]);
  });
  test('job at end', () => {
    expect(subtractIntervals([[9*60, 17*60]], [[15*60, 17*60]]))
      .toEqual([[9*60, 15*60]]);
  });
  test('job fully covers base → empty', () => {
    expect(subtractIntervals([[9*60, 17*60]], [[8*60, 18*60]])).toEqual([]);
  });
  test('overlapping subtract intervals get merged', () => {
    expect(subtractIntervals([[9*60, 17*60]], [[10*60, 12*60], [11*60, 14*60]]))
      .toEqual([[9*60, 10*60], [14*60, 17*60]]);
  });
  test('multi-block base with subtract in only one block', () => {
    expect(subtractIntervals(
      [[8*60, 12*60], [13*60, 17*60]],
      [[14*60, 15*60]]
    )).toEqual([[8*60, 12*60], [13*60, 14*60], [15*60, 17*60]]);
  });
});

describe('cleanerAvailabilityForDate', () => {
  const avail = {
    monday: { start: '09:00', end: '17:00' },
    customAvailability: [
      { date: '2026-08-14', available: false, source: 'zenbooker' },
    ],
  };

  test('working, no jobs → AM and PM both available', () => {
    const r = cleanerAvailabilityForDate({
      availability: avail, jobIntervals: [], dateStr: '2026-08-10',
    });
    expect(r.amAvailable).toBe(true);
    expect(r.pmAvailable).toBe(true);
    expect(r.offDay).toBe(false);
  });

  test('single job 10:00–12:00 → AM still available (9-10 remains), PM available', () => {
    const r = cleanerAvailabilityForDate({
      availability: avail,
      jobIntervals: [[10*60, 12*60]],
      dateStr: '2026-08-10',
    });
    expect(r.amAvailable).toBe(true);
    expect(r.pmAvailable).toBe(true);
  });

  test('full-day job 09:00–17:00 → nothing available', () => {
    const r = cleanerAvailabilityForDate({
      availability: avail,
      jobIntervals: [[9*60, 17*60]],
      dateStr: '2026-08-10',
    });
    expect(r.amAvailable).toBe(false);
    expect(r.pmAvailable).toBe(false);
  });

  test('off day (ZB override) → not available', () => {
    const r = cleanerAvailabilityForDate({
      availability: avail, jobIntervals: [], dateStr: '2026-08-14',
    });
    expect(r.amAvailable).toBe(false);
    expect(r.pmAvailable).toBe(false);
    expect(r.offDay).toBe(true);
  });

  test('AM eaten but PM free — 09:00-14:00 job leaves nothing in AM window, PM still 14-17', () => {
    const r = cleanerAvailabilityForDate({
      availability: avail,
      jobIntervals: [[9*60, 14*60]],
      dateStr: '2026-08-10',
    });
    // AM window 9-14 fully consumed by job, PM 13-18 has 14-17 remaining
    expect(r.amAvailable).toBe(false);
    expect(r.pmAvailable).toBe(true);
  });

  test('one-hour overlap window: job 13:00-14:00 leaves both halves partially free', () => {
    const r = cleanerAvailabilityForDate({
      availability: avail,
      jobIntervals: [[13*60, 14*60]],
      dateStr: '2026-08-10',
    });
    // AM window 9-14 has 9-13 remaining, PM window 13-18 has 14-17 remaining
    expect(r.amAvailable).toBe(true);
    expect(r.pmAvailable).toBe(true);
  });
});

describe('jobIntervalOnDate', () => {
  test('same-day job → intersected minutes', () => {
    const r = jobIntervalOnDate('2026-08-10T10:00:00', '2026-08-10T12:00:00', '2026-08-10');
    expect(r).toEqual([10*60, 12*60]);
  });
  test('job on different date → null', () => {
    expect(jobIntervalOnDate('2026-08-11T10:00:00', '2026-08-11T12:00:00', '2026-08-10')).toBeNull();
  });
  test('job spanning midnight → returns portion on requested date', () => {
    // 2026-08-10 23:00 → 2026-08-11 02:00, ask for 2026-08-10
    const r = jobIntervalOnDate('2026-08-10T23:00:00', '2026-08-11T02:00:00', '2026-08-10');
    expect(r).toEqual([23*60, 24*60]);
  });
});

describe('computeCapacityBusyWindows — integration', () => {
  const clean = (id, avail) => ({ id, availability: avail });
  const weeklyOnly = (start, end) => ({
    monday: { start, end }, tuesday: { start, end }, wednesday: { start, end },
    thursday: { start, end }, friday: { start, end }, saturday: { start, end }, sunday: { start, end },
  });

  test('single cleaner, no jobs → no busy', () => {
    const busy = computeCapacityBusyWindows({
      cleaners: [clean(1, weeklyOnly('09:00', '17:00'))],
      jobsByDateByCleaner: new Map(),
      dates: ['2026-08-10'],
    });
    expect(busy).toEqual([]);
  });

  test('single cleaner fully booked → both halves busy', () => {
    const busy = computeCapacityBusyWindows({
      cleaners: [clean(1, weeklyOnly('09:00', '17:00'))],
      jobsByDateByCleaner: new Map([
        ['2026-08-10', new Map([[1, [[9*60, 17*60]]]])],
      ]),
      dates: ['2026-08-10'],
    });
    expect(busy).toEqual([
      { start: '2026-08-10T09:00:00', end: '2026-08-10T14:00:00' },
      { start: '2026-08-10T13:00:00', end: '2026-08-10T18:00:00' },
    ]);
  });

  test('single cleaner off day → both halves busy', () => {
    const avail = {
      monday: { available: false },
      customAvailability: [],
    };
    const busy = computeCapacityBusyWindows({
      cleaners: [clean(1, avail)],
      jobsByDateByCleaner: new Map(),
      dates: ['2026-08-10'], // Monday
    });
    expect(busy).toHaveLength(2);
  });

  test('3 cleaners, 1 booked → both halves FREE (2 still available)', () => {
    const busy = computeCapacityBusyWindows({
      cleaners: [
        clean(1, weeklyOnly('09:00', '17:00')),
        clean(2, weeklyOnly('09:00', '17:00')),
        clean(3, weeklyOnly('09:00', '17:00')),
      ],
      jobsByDateByCleaner: new Map([
        ['2026-08-10', new Map([[1, [[9*60, 17*60]]]])],
      ]),
      dates: ['2026-08-10'],
    });
    expect(busy).toEqual([]);
  });

  test('3 cleaners all fully booked → both halves BUSY', () => {
    const busy = computeCapacityBusyWindows({
      cleaners: [
        clean(1, weeklyOnly('09:00', '17:00')),
        clean(2, weeklyOnly('09:00', '17:00')),
        clean(3, weeklyOnly('09:00', '17:00')),
      ],
      jobsByDateByCleaner: new Map([
        ['2026-08-10', new Map([
          [1, [[9*60, 17*60]]],
          [2, [[9*60, 17*60]]],
          [3, [[9*60, 17*60]]],
        ])],
      ]),
      dates: ['2026-08-10'],
    });
    expect(busy).toHaveLength(2);
  });

  test('3 cleaners: 2 off, 1 booked → both halves BUSY', () => {
    const off = { monday: { available: false }, customAvailability: [] };
    const busy = computeCapacityBusyWindows({
      cleaners: [
        clean(1, off),
        clean(2, off),
        clean(3, weeklyOnly('09:00', '17:00')),
      ],
      jobsByDateByCleaner: new Map([
        ['2026-08-10', new Map([[3, [[9*60, 17*60]]]])],
      ]),
      dates: ['2026-08-10'],
    });
    expect(busy).toHaveLength(2);
  });

  test('3 cleaners: 2 off, 1 free → both halves FREE', () => {
    const off = { monday: { available: false }, customAvailability: [] };
    const busy = computeCapacityBusyWindows({
      cleaners: [
        clean(1, off),
        clean(2, off),
        clean(3, weeklyOnly('09:00', '17:00')),
      ],
      jobsByDateByCleaner: new Map(),
      dates: ['2026-08-10'],
    });
    expect(busy).toEqual([]);
  });

  test('AM-only busy on one date, PM free', () => {
    // Single cleaner working 09-17, has a 09:00-14:00 job (fills AM window)
    const busy = computeCapacityBusyWindows({
      cleaners: [clean(1, weeklyOnly('09:00', '17:00'))],
      jobsByDateByCleaner: new Map([
        ['2026-08-10', new Map([[1, [[9*60, 14*60]]]])],
      ]),
      dates: ['2026-08-10'],
    });
    expect(busy).toEqual([
      { start: '2026-08-10T09:00:00', end: '2026-08-10T14:00:00' },
    ]);
  });

  test('empty cleaner list → every date fully busy AM+PM', () => {
    const busy = computeCapacityBusyWindows({
      cleaners: [],
      jobsByDateByCleaner: new Map(),
      dates: ['2026-08-10', '2026-08-11'],
    });
    expect(busy).toHaveLength(4);
  });
});

describe('enumerateDates', () => {
  test('single day', () => {
    const from = new Date('2026-08-10T00:00:00').getTime();
    const to = new Date('2026-08-10T23:59:59').getTime();
    expect(enumerateDates(from, to)).toEqual(['2026-08-10']);
  });
  test('multi-day', () => {
    const from = new Date('2026-08-10T00:00:00').getTime();
    const to = new Date('2026-08-12T00:00:00').getTime();
    expect(enumerateDates(from, to)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
  });
});

describe('window constants sanity', () => {
  test('AM 09:00-14:00, PM 13:00-18:00', () => {
    expect(AM_START_MIN).toBe(9 * 60);
    expect(AM_END_MIN).toBe(14 * 60);
    expect(PM_START_MIN).toBe(13 * 60);
    expect(PM_END_MIN).toBe(18 * 60);
  });
  test('AM and PM overlap between 13:00-14:00', () => {
    expect(AM_END_MIN).toBeGreaterThan(PM_START_MIN);
    expect(PM_START_MIN).toBeLessThan(AM_END_MIN);
  });
});
