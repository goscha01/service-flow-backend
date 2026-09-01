'use strict';

const {
  computeTeamFreeWindows,
  enumerateDates,
  jobIntervalOnDate,
} = require('../lib/lb-orchestration-free-windows');

const WEEKLY_9_18 = {
  monday:    { start: '09:00', end: '18:00' },
  tuesday:   { start: '09:00', end: '18:00' },
  wednesday: { start: '09:00', end: '18:00' },
  thursday:  { start: '09:00', end: '18:00' },
  friday:    { start: '09:00', end: '18:00' },
  saturday:  { available: false },
  sunday:    { available: false },
};

describe('computeTeamFreeWindows', () => {
  test('returns whole shift when cleaner has no jobs', () => {
    const cleaners = [{ id: 1, first_name: 'Alice', last_name: 'A', availability: WEEKLY_9_18 }];
    const dates = ['2026-08-19']; // Wednesday
    const result = computeTeamFreeWindows({
      cleaners,
      jobsByDateByCleaner: new Map(),
      dates,
    });
    expect(result).toHaveLength(1);
    expect(result[0].team_member_id).toBe(1);
    expect(result[0].days[0]).toEqual({
      date: '2026-08-19',
      shift_minutes: 9 * 60,
      free_minutes: 9 * 60,
      free_windows: [{ start: '09:00', end: '18:00' }],
      off: false,
    });
    expect(result[0].totals).toEqual({ shift_minutes: 540, free_minutes: 540 });
  });

  test('subtracts booked jobs from shift — Kovtun-style day (jobs 10a-1p + 1p-5:30p leave 9-10a and 5:30-6p)', () => {
    const cleaners = [{ id: 2641, first_name: 'Tatiana', last_name: 'Kovtun', availability: WEEKLY_9_18 }];
    const dates = ['2026-08-19'];
    const jobsByDateByCleaner = new Map([
      ['2026-08-19', new Map([
        [2641, [[10 * 60, 13 * 60], [13 * 60, 17 * 60 + 30]]],
      ])],
    ]);
    const result = computeTeamFreeWindows({ cleaners, jobsByDateByCleaner, dates });
    expect(result[0].days[0].free_windows).toEqual([
      { start: '09:00', end: '10:00' },
      { start: '17:30', end: '18:00' },
    ]);
    expect(result[0].days[0].free_minutes).toBe(60 + 30);
    expect(result[0].days[0].shift_minutes).toBe(9 * 60);
  });

  test('marks off:true when cleaner has no shift on that day', () => {
    const cleaners = [{ id: 3, first_name: 'Bob', availability: WEEKLY_9_18 }];
    const dates = ['2026-08-22']; // Saturday — weekly says available:false
    const result = computeTeamFreeWindows({
      cleaners,
      jobsByDateByCleaner: new Map(),
      dates,
    });
    expect(result[0].days[0]).toEqual({
      date: '2026-08-22',
      shift_minutes: 0,
      free_minutes: 0,
      free_windows: [],
      off: true,
    });
  });

  test('honors customAvailability override', () => {
    const avail = {
      ...WEEKLY_9_18,
      customAvailability: [
        { date: '2026-08-19', available: true, hours: [{ start: '13:00', end: '17:00' }] },
      ],
    };
    const cleaners = [{ id: 4, first_name: 'Nat', availability: avail }];
    const dates = ['2026-08-19'];
    const result = computeTeamFreeWindows({
      cleaners,
      jobsByDateByCleaner: new Map(),
      dates,
    });
    expect(result[0].days[0].shift_minutes).toBe(4 * 60);
    expect(result[0].days[0].free_windows).toEqual([{ start: '13:00', end: '17:00' }]);
  });

  test('handles overlapping jobs (double-book) — subtracts the union', () => {
    const cleaners = [{ id: 5, first_name: 'X', availability: WEEKLY_9_18 }];
    const dates = ['2026-08-19'];
    const jobsByDateByCleaner = new Map([
      ['2026-08-19', new Map([
        [5, [[10 * 60, 12 * 60], [11 * 60, 14 * 60]]], // overlap 11-12
      ])],
    ]);
    const result = computeTeamFreeWindows({ cleaners, jobsByDateByCleaner, dates });
    expect(result[0].days[0].free_windows).toEqual([
      { start: '09:00', end: '10:00' },
      { start: '14:00', end: '18:00' },
    ]);
    expect(result[0].days[0].free_minutes).toBe(60 + 4 * 60);
  });

  test('multi-day range and totals across a week', () => {
    const cleaners = [{ id: 6, first_name: 'Y', availability: WEEKLY_9_18 }];
    const dates = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-22', '2026-08-23'];
    // one job Mon, none Tue/Wed, Sat/Sun off
    const jobsByDateByCleaner = new Map([
      ['2026-08-17', new Map([[6, [[9 * 60, 12 * 60]]]])],
    ]);
    const result = computeTeamFreeWindows({ cleaners, jobsByDateByCleaner, dates });
    const daysByDate = Object.fromEntries(result[0].days.map(d => [d.date, d]));
    expect(daysByDate['2026-08-17'].free_minutes).toBe(6 * 60);
    expect(daysByDate['2026-08-18'].free_minutes).toBe(9 * 60);
    expect(daysByDate['2026-08-19'].free_minutes).toBe(9 * 60);
    expect(daysByDate['2026-08-22'].off).toBe(true);
    expect(daysByDate['2026-08-23'].off).toBe(true);
    expect(result[0].totals.free_minutes).toBe(6 * 60 + 9 * 60 + 9 * 60);
    expect(result[0].totals.shift_minutes).toBe(9 * 60 + 9 * 60 + 9 * 60);
  });

  test('re-exports enumerateDates and jobIntervalOnDate from capacity module', () => {
    expect(typeof enumerateDates).toBe('function');
    expect(typeof jobIntervalOnDate).toBe('function');
    expect(enumerateDates(
      new Date('2026-08-17T00:00:00').getTime(),
      new Date('2026-08-19T00:00:00').getTime(),
    )).toEqual(['2026-08-17', '2026-08-18', '2026-08-19']);
  });
});
