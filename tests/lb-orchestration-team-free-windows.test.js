'use strict';

/**
 * /orchestration/team-free-windows — hermetic handler tests.
 *
 * Covers:
 *   - 400 when from/to missing
 *   - 400 when to <= from
 *   - 400 when range > 60 days
 *   - excludes non-service-providers and inactive rows (managers stay out)
 *   - subtracts booked jobs per cleaner (Kovtun-style split)
 *   - falls back to jobs.team_member_id when no job_team_assignments row
 *   - honors sf_location_id (territory filter on team_members + jobs)
 *   - fail-closed on unresolved external_business_id
 *   - audits to lb_orchestration_attempts
 */

process.env.SF_INTEGRATION_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

const { makeTeamFreeWindowsHandler } = require('../lib/lb-orchestration-handlers');

function makeStub({ teamMembers = [], jobs = [] } = {}) {
  const inserts = [];
  return {
    _inserts: inserts,
    from(table) {
      const filter = {};
      let inserting = null;
      const chain = {
        select() { return chain; },
        eq(k, v) { filter[k] = v; return chain; },
        neq(k, v) { filter[`__neq_${k}`] = v; return chain; },
        gte(k, v) { filter[`__gte_${k}`] = v; return chain; },
        lte(k, v) { filter[`__lte_${k}`] = v; return chain; },
        lt(k, v)  { filter[`__lt_${k}`]  = v; return chain; },
        in() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        insert(row) { inserting = row; inserts.push({ table, row }); return chain; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(resolve) {
          if (inserting) return void resolve({ error: null });
          if (table === 'team_members') {
            const rows = teamMembers.filter(t => matches(t, filter));
            return void resolve({ data: rows, error: null });
          }
          if (table === 'jobs') {
            const rows = jobs.filter(j => matches(j, filter));
            return void resolve({ data: rows, error: null });
          }
          resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
  function matches(r, filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (k.startsWith('__gte_')) {
        const c = k.slice(6);
        if (String(r[c] || '') < String(v)) return false;
      } else if (k.startsWith('__lte_')) {
        const c = k.slice(6);
        if (String(r[c] || '') > String(v)) return false;
      } else if (k.startsWith('__lt_')) {
        const c = k.slice(5);
        if (!(String(r[c] || '') < String(v))) return false;
      } else if (k.startsWith('__neq_')) {
        const c = k.slice(6);
        if (String(r[c]) === String(v)) return false;
      } else {
        if (String(r[k]) !== String(v)) return false;
      }
    }
    return true;
  }
}

const SILENT = { log() {}, warn() {}, error() {} };
function mockRes() {
  return {
    _status: 200, _body: null,
    status(c) { this._status = c; return this; },
    json(b) { this._body = b; return this; },
  };
}

const WEEKLY_9_18 = {
  monday:    { start: '09:00', end: '18:00' },
  tuesday:   { start: '09:00', end: '18:00' },
  wednesday: { start: '09:00', end: '18:00' },
  thursday:  { start: '09:00', end: '18:00' },
  friday:    { start: '09:00', end: '18:00' },
  saturday:  { available: false },
  sunday:    { available: false },
};

describe('team-free-windows handler — validation', () => {
  test('400 when from/to missing', async () => {
    const h = makeTeamFreeWindowsHandler({ supabase: makeStub(), logger: SILENT });
    const res = mockRes();
    await h({ user: { userId: 2 }, query: {} }, res);
    expect(res._status).toBe(400);
  });

  test('400 when to <= from', async () => {
    const h = makeTeamFreeWindowsHandler({ supabase: makeStub(), logger: SILENT });
    const res = mockRes();
    await h({ user: { userId: 2 }, query: { from: '2026-08-19', to: '2026-08-19' } }, res);
    expect(res._status).toBe(400);
  });

  test('400 when range > 60 days', async () => {
    const h = makeTeamFreeWindowsHandler({ supabase: makeStub(), logger: SILENT });
    const res = mockRes();
    await h({ user: { userId: 2 }, query: { from: '2026-01-01', to: '2026-06-01' } }, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/range too large/);
  });
});

describe('team-free-windows handler — filtering', () => {
  test('excludes non-service-providers, inactive, managers', async () => {
    const teamMembers = [
      { id: 1, first_name: 'Field', last_name: 'Alice', user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner', availability: WEEKLY_9_18 },
      { id: 2, first_name: 'Manager', last_name: 'Bob', is_service_provider: false, is_active: true, status: 'active', role: 'manager', availability: WEEKLY_9_18 },
      { id: 3, first_name: 'Owner', last_name: 'Carol', is_service_provider: true, is_active: true, status: 'active', role: 'account owner', availability: WEEKLY_9_18 },
      { id: 4, first_name: 'Inactive', last_name: 'Dan', is_service_provider: true, is_active: false, status: 'inactive', role: 'cleaner', availability: WEEKLY_9_18 },
    ];
    const h = makeTeamFreeWindowsHandler({ supabase: makeStub({ teamMembers }), logger: SILENT });
    const res = mockRes();
    await h({ user: { userId: 2 }, query: { from: '2026-08-19T00:00:00Z', to: '2026-08-19T23:59:00Z' } }, res);
    expect(res._status).toBe(200);
    const ids = res._body.team.map(t => t.team_member_id);
    expect(ids).toEqual([1]);
  });
});

describe('team-free-windows handler — free window math', () => {
  test('Kovtun-style day: shift 9-18, jobs 10a-1p + 1p-5:30p → free 9-10 and 5:30-6', async () => {
    const teamMembers = [{
      id: 2641, first_name: 'Tatiana', last_name: 'Kovtun',
      user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner',
      availability: WEEKLY_9_18,
    }];
    const jobs = [
      { id: 142619, user_id: 2, status: 'en-route', team_member_id: 2641, scheduled_date: '2026-08-19 10:00:00', duration: 180, end_time: null, job_team_assignments: [{ team_member_id: 2641 }] },
      { id: 142620, user_id: 2, status: 'scheduled', team_member_id: 2641, scheduled_date: '2026-08-19 13:00:00', duration: 270, end_time: null, job_team_assignments: [] },
    ];
    const h = makeTeamFreeWindowsHandler({ supabase: makeStub({ teamMembers, jobs }), logger: SILENT });
    const res = mockRes();
    await h({ user: { userId: 2 }, query: { from: '2026-08-19T00:00:00', to: '2026-08-19T23:59:00' } }, res);
    expect(res._status).toBe(200);
    const day = res._body.team[0].days.find(d => d.date === '2026-08-19');
    expect(day.free_windows).toEqual([
      { start: '09:00', end: '10:00' },
      { start: '17:30', end: '18:00' },
    ]);
    expect(day.free_minutes).toBe(90);
    expect(day.shift_minutes).toBe(9 * 60);
    expect(day.off).toBe(false);
  });

  test('skips jobs whose scheduled_date has no time component (avoids poisoning from dead scheduled_time default)', async () => {
    const teamMembers = [{
      id: 1, first_name: 'A', user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner',
      availability: WEEKLY_9_18,
    }];
    const jobs = [
      // Date-only scheduled_date — should be skipped, not treated as 09:00 start
      { id: 1, user_id: 2, status: 'scheduled', team_member_id: 1, scheduled_date: '2026-08-19', duration: 180, end_time: null, job_team_assignments: [] },
    ];
    const h = makeTeamFreeWindowsHandler({ supabase: makeStub({ teamMembers, jobs }), logger: SILENT });
    const res = mockRes();
    await h({ user: { userId: 2 }, query: { from: '2026-08-19T00:00:00', to: '2026-08-19T23:59:00' } }, res);
    const day = res._body.team[0].days.find(d => d.date === '2026-08-19');
    expect(day.free_minutes).toBe(9 * 60);
    expect(day.free_windows).toEqual([{ start: '09:00', end: '18:00' }]);
  });

  test('excludes cancelled jobs from subtraction', async () => {
    const teamMembers = [{
      id: 1, first_name: 'A', user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner',
      availability: WEEKLY_9_18,
    }];
    const jobs = [
      { id: 1, status: 'cancelled', team_member_id: 1, scheduled_date: '2026-08-19 10:00:00', duration: 180, end_time: null, job_team_assignments: [] },
    ];
    const h = makeTeamFreeWindowsHandler({ supabase: makeStub({ teamMembers, jobs }), logger: SILENT });
    const res = mockRes();
    await h({ user: { userId: 2 }, query: { from: '2026-08-19T00:00:00', to: '2026-08-19T23:59:00' } }, res);
    const day = res._body.team[0].days.find(d => d.date === '2026-08-19');
    expect(day.free_minutes).toBe(9 * 60);
  });
});

describe('team-free-windows handler — scope', () => {
  test('fail-closed when external_business_id cannot be resolved', async () => {
    const h = makeTeamFreeWindowsHandler({
      supabase: makeStub(), logger: SILENT,
      resolveLocationForOrchestrationScope: async () => ({ locationId: null, resolution: 'unknown_business' }),
    });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-08-19T00:00:00', to: '2026-08-19T23:59:00', external_business_id: 'yelp-XYZ' },
    }, res);
    expect(res._status).toBe(200);
    expect(res._body.team).toEqual([]);
    expect(res._body.scope.resolution).toBe('unknown_business');
  });

  // Regression pin for the 2026-08-20 cross-territory-double-booking fix.
  // A cleaner assigned to two territories has ONE physical calendar — a
  // job in territory B makes them unavailable regardless of which
  // territory a caller queries about. Prior behavior filtered `jobs` by
  // `territory_id = scopedLocationId`, so a query for territory A did
  // not subtract the cleaner's territory-B jobs and returned that slot
  // as "free" — letting LB double-book them.
  //
  // New behavior: scope filters WHICH cleaners are returned (must be
  // assigned to the queried territory), but ALL of that cleaner's
  // jobs are subtracted, so free_windows reflect true availability.
  test('scoped call still subtracts cross-territory jobs from a multi-territory cleaner', async () => {
    const teamMembers = [{
      id: 100, first_name: 'CrossTerr', last_name: 'Cleaner',
      user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner',
      territories: [341, 345], // Jacksonville + Tampa
      availability: WEEKLY_9_18,
    }];
    const jobs = [
      // Job in Tampa (345) — must still subtract when caller queries JAX (341)
      { id: 1, user_id: 2, status: 'scheduled', team_member_id: 100,
        territory_id: 345,
        scheduled_date: '2026-08-19 14:00:00', duration: 120, end_time: null,
        job_team_assignments: [{ team_member_id: 100 }] },
    ];
    const h = makeTeamFreeWindowsHandler({ supabase: makeStub({ teamMembers, jobs }), logger: SILENT });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-08-19T00:00:00', to: '2026-08-19T23:59:00', sf_location_id: '341' },
    }, res);
    expect(res._status).toBe(200);
    expect(res._body.scope).toEqual({ resolution: 'explicit', location_id: 341 });
    // Cleaner is in the returned team (assigned to JAX).
    expect(res._body.team.map(t => t.team_member_id)).toEqual([100]);
    const day = res._body.team[0].days.find(d => d.date === '2026-08-19');
    // Free windows MUST omit 14:00-16:00 (that Tampa job) — this is the
    // real availability the AI booking path needs to trust.
    expect(day.free_windows).toEqual([
      { start: '09:00', end: '14:00' },
      { start: '16:00', end: '18:00' },
    ]);
    expect(day.free_minutes).toBe(7 * 60); // 9h shift - 2h cross-territory job
  });
});

describe('team-free-windows handler — audit', () => {
  test('inserts one row into lb_orchestration_attempts', async () => {
    const teamMembers = [{ id: 1, first_name: 'A', user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner', availability: WEEKLY_9_18 }];
    const stub = makeStub({ teamMembers });
    const h = makeTeamFreeWindowsHandler({ supabase: stub, logger: SILENT });
    await h({ user: { userId: 2 }, query: { from: '2026-08-19T00:00:00', to: '2026-08-19T23:59:00' } }, mockRes());
    const audit = stub._inserts.filter(i => i.table === 'lb_orchestration_attempts');
    expect(audit.length).toBe(1);
    expect(audit[0].row.endpoint).toBe('team_free_windows');
    expect(audit[0].row.result).toBe('success');
  });
});
