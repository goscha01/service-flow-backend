'use strict';

/**
 * Tests for lib/zenbooker-availability-reconcile.js.
 *
 * Coverage:
 *   1. Pure helpers: unionSlotsByDate, buildEnvelopeEntries, mergeCustomAvailability.
 *   2. Envelope = min slot start, max slot end per date.
 *   3. Dates with zero slots are OMITTED (not written as available:false).
 *   4. Manual customAvailability entries (source unset) are preserved across runs.
 *   5. Same-date manual entry wins over ZB envelope.
 *   6. Multi-territory union.
 *   7. Fetch failure on one territory doesn't abort the others.
 *   8. All /timeslots calls fail → skipped_fetch_failed (no write).
 *   9. No ZB-linked territories → skipped_no_territories.
 *  10. Dry-run performs no update.
 *  11. Idempotent — second run over unchanged /timeslots response = no_change.
 *  12. Tenant sweep filters by user_id + zenbooker_id NOT NULL.
 *  13. Weekly schedule (monday..sunday) is preserved through the write.
 */

const {
  reconcileTeamMemberAvailability,
  reconcileTenantAvailability,
  unionSlotsByDate,
  buildEnvelopeEntries,
  mergeCustomAvailability,
  extractHHMM,
  ZB_SOURCE_MARKER,
} = require('../lib/zenbooker-availability-reconcile');

function quietLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

// ── Minimal in-memory Supabase mock ────────────────────────────────
//
// Surface used by the reconciler:
//   .from(t).select().eq().not(col, 'is', null)               → list rows
//   .from(t).update({ availability }).eq('id', x)             → mutate row

function makeSupabase(seed = {}) {
  const state = {
    team_members: (seed.team_members || []).map(r => ({ ...r })),
    territories: (seed.territories || []).map(r => ({ ...r })),
    users: (seed.users || []).map(r => ({ ...r })),
  };

  function buildSelectChain(tableName) {
    const filters = [];
    const applyFilters = (rows) => rows.filter(r =>
      filters.every(f => {
        if (f.op === 'eq') return r[f.col] === f.val;
        if (f.op === 'not_is_null') return r[f.col] !== null && r[f.col] !== undefined;
        return true;
      })
    );
    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      not(col, op, val) {
        if (op === 'is' && val === null) filters.push({ op: 'not_is_null', col });
        return chain;
      },
      then(resolve, reject) {
        const rows = applyFilters(state[tableName] || []);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return chain;
  }

  function buildUpdateChain(tableName, patch) {
    const filters = [];
    const applyFilters = (rows) => rows.filter(r =>
      filters.every(f => f.op === 'eq' && r[f.col] === f.val)
    );
    const chain = {
      eq(col, val) {
        filters.push({ op: 'eq', col, val });
        const matched = applyFilters(state[tableName] || []);
        for (const row of matched) Object.assign(row, patch);
        return Promise.resolve({ data: matched, error: null });
      },
    };
    return chain;
  }

  return {
    from(tableName) {
      return {
        select: (...a) => buildSelectChain(tableName).select(...a),
        update: (patch) => buildUpdateChain(tableName, patch),
      };
    },
    _state: state,
  };
}

// ── Pure helpers ───────────────────────────────────────────────────

describe('extractHHMM', () => {
  test('parses HH:MM from ISO datetime', () => {
    expect(extractHHMM('2026-08-11T09:00:00-04:00')).toBe('09:00');
    expect(extractHHMM('2026-08-11T17:30:00Z')).toBe('17:30');
  });
  test('returns null for empty / non-string', () => {
    expect(extractHHMM(null)).toBeNull();
    expect(extractHHMM('')).toBeNull();
    expect(extractHHMM('nope')).toBeNull();
  });
});

describe('unionSlotsByDate', () => {
  test('merges slots from multiple territory responses per date', () => {
    const responses = [
      { days: [
        { date: '2026-08-11', timeslots: [{ start: '2026-08-11T09:00:00', end: '2026-08-11T11:00:00' }] },
      ]},
      { days: [
        { date: '2026-08-11', timeslots: [{ start: '2026-08-11T14:00:00', end: '2026-08-11T16:00:00' }] },
      ]},
    ];
    const byDate = unionSlotsByDate(responses);
    expect(byDate.get('2026-08-11')).toEqual([
      { start: '2026-08-11T09:00:00', end: '2026-08-11T11:00:00' },
      { start: '2026-08-11T14:00:00', end: '2026-08-11T16:00:00' },
    ]);
  });

  test('empty responses → empty map', () => {
    expect(unionSlotsByDate([]).size).toBe(0);
    expect(unionSlotsByDate([{ days: [] }]).size).toBe(0);
  });
});

describe('buildEnvelopeEntries', () => {
  test('envelope = min slot start, max slot end per date', () => {
    const byDate = new Map([
      ['2026-08-11', [
        { start: '2026-08-11T14:00:00', end: '2026-08-11T16:00:00' },
        { start: '2026-08-11T09:00:00', end: '2026-08-11T11:00:00' },
      ]],
    ]);
    const entries = buildEnvelopeEntries(byDate);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      date: '2026-08-11',
      available: true,
      hours: [{ start: '09:00', end: '16:00' }],
      source: 'zenbooker',
    });
  });

  test('dates with zero slots are OMITTED (not written as available:false)', () => {
    const byDate = new Map([
      ['2026-08-11', []],
      ['2026-08-12', [{ start: '2026-08-12T09:00:00', end: '2026-08-12T17:00:00' }]],
    ]);
    const entries = buildEnvelopeEntries(byDate);
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2026-08-12');
  });

  test('entries sorted by date ascending', () => {
    const byDate = new Map([
      ['2026-08-15', [{ start: '2026-08-15T09:00:00', end: '2026-08-15T17:00:00' }]],
      ['2026-08-11', [{ start: '2026-08-11T09:00:00', end: '2026-08-11T17:00:00' }]],
    ]);
    const entries = buildEnvelopeEntries(byDate);
    expect(entries.map(e => e.date)).toEqual(['2026-08-11', '2026-08-15']);
  });
});

describe('mergeCustomAvailability', () => {
  test('preserves manual entries (no source marker)', () => {
    const existing = [
      { date: '2026-08-01', available: false }, // manual time-off
    ];
    const newZb = [
      { date: '2026-08-11', available: true, hours: [{ start: '09:00', end: '17:00' }], source: 'zenbooker' },
    ];
    const merged = mergeCustomAvailability(existing, newZb);
    expect(merged).toHaveLength(2);
    expect(merged.find(e => e.date === '2026-08-01')).toEqual({ date: '2026-08-01', available: false });
    expect(merged.find(e => e.date === '2026-08-11').source).toBe('zenbooker');
  });

  test('wipes prior ZB-source entries on reconciler run', () => {
    const existing = [
      { date: '2026-08-11', available: true, hours: [{ start: '08:00', end: '12:00' }], source: 'zenbooker' },
    ];
    const newZb = [
      { date: '2026-08-11', available: true, hours: [{ start: '09:00', end: '17:00' }], source: 'zenbooker' },
    ];
    const merged = mergeCustomAvailability(existing, newZb);
    expect(merged).toHaveLength(1);
    expect(merged[0].hours[0].start).toBe('09:00');
  });

  test('manual entry on same date wins over ZB envelope', () => {
    const existing = [
      { date: '2026-08-11', available: false }, // manual vacation
    ];
    const newZb = [
      { date: '2026-08-11', available: true, hours: [{ start: '09:00', end: '17:00' }], source: 'zenbooker' },
    ];
    const merged = mergeCustomAvailability(existing, newZb);
    expect(merged).toHaveLength(1);
    expect(merged[0].available).toBe(false);
    expect(merged[0].source).toBeUndefined();
  });

  test('handles missing / non-array existing', () => {
    const newZb = [{ date: '2026-08-11', available: true, hours: [{ start: '09:00', end: '17:00' }], source: 'zenbooker' }];
    expect(mergeCustomAvailability(null, newZb)).toEqual(newZb);
    expect(mergeCustomAvailability(undefined, newZb)).toEqual(newZb);
    expect(mergeCustomAvailability('not an array', newZb)).toEqual(newZb);
  });
});

// ── reconcileTeamMemberAvailability ───────────────────────────────

describe('reconcileTeamMemberAvailability', () => {
  const baseTerritoryLookup = new Map([
    [10, { id: 10, zenbooker_id: 'zb_terr_a' }],
    [11, { id: 11, zenbooker_id: 'zb_terr_b' }],
  ]);

  test('writes envelope entries when apply=true', async () => {
    const supabase = makeSupabase({
      team_members: [{ id: 1, user_id: 2, zenbooker_id: 'zb_prov_1', territories: [10], availability: null }],
    });
    const zbFetchFn = jest.fn().mockResolvedValue({
      days: [
        { date: '2026-08-11', timeslots: [{ start: '2026-08-11T09:00:00', end: '2026-08-11T17:00:00' }] },
      ],
    });
    const result = await reconcileTeamMemberAvailability({
      supabase,
      teamMember: supabase._state.team_members[0],
      territoriesLookup: baseTerritoryLookup,
      apiKey: 'k',
      dryRun: false,
      zbFetchFn,
      logger: quietLogger(),
    });
    expect(result.action).toBe('written');
    expect(result.datesWritten).toBe(1);
    const written = supabase._state.team_members[0].availability;
    expect(written.customAvailability).toHaveLength(1);
    expect(written.customAvailability[0].source).toBe('zenbooker');
  });

  test('unions slots across multiple territories', async () => {
    const supabase = makeSupabase({
      team_members: [{ id: 1, user_id: 2, zenbooker_id: 'zb_prov_1', territories: [10, 11], availability: null }],
    });
    const zbFetchFn = jest.fn()
      .mockResolvedValueOnce({
        days: [{ date: '2026-08-11', timeslots: [{ start: '2026-08-11T09:00:00', end: '2026-08-11T11:00:00' }] }],
      })
      .mockResolvedValueOnce({
        days: [{ date: '2026-08-11', timeslots: [{ start: '2026-08-11T14:00:00', end: '2026-08-11T17:00:00' }] }],
      });
    const result = await reconcileTeamMemberAvailability({
      supabase,
      teamMember: supabase._state.team_members[0],
      territoriesLookup: baseTerritoryLookup,
      apiKey: 'k',
      dryRun: false,
      zbFetchFn,
      logger: quietLogger(),
    });
    expect(result.action).toBe('written');
    expect(zbFetchFn).toHaveBeenCalledTimes(2);
    const written = supabase._state.team_members[0].availability.customAvailability;
    expect(written[0].hours[0]).toEqual({ start: '09:00', end: '17:00' });
  });

  test('one territory fetch fails, others succeed → still writes', async () => {
    const supabase = makeSupabase({
      team_members: [{ id: 1, user_id: 2, zenbooker_id: 'zb_prov_1', territories: [10, 11], availability: null }],
    });
    const zbFetchFn = jest.fn()
      .mockRejectedValueOnce(new Error('Zenbooker API 502: bad gateway'))
      .mockResolvedValueOnce({
        days: [{ date: '2026-08-11', timeslots: [{ start: '2026-08-11T09:00:00', end: '2026-08-11T17:00:00' }] }],
      });
    const result = await reconcileTeamMemberAvailability({
      supabase,
      teamMember: supabase._state.team_members[0],
      territoriesLookup: baseTerritoryLookup,
      apiKey: 'k',
      dryRun: false,
      zbFetchFn,
      logger: quietLogger(),
    });
    expect(result.action).toBe('written');
  });

  test('ALL territory fetches fail → skipped_fetch_failed, no write', async () => {
    const supabase = makeSupabase({
      team_members: [{ id: 1, user_id: 2, zenbooker_id: 'zb_prov_1', territories: [10, 11], availability: null }],
    });
    const zbFetchFn = jest.fn().mockRejectedValue(new Error('Zenbooker API 502'));
    const result = await reconcileTeamMemberAvailability({
      supabase,
      teamMember: supabase._state.team_members[0],
      territoriesLookup: baseTerritoryLookup,
      apiKey: 'k',
      dryRun: false,
      zbFetchFn,
      logger: quietLogger(),
    });
    expect(result.action).toBe('skipped_fetch_failed');
    expect(supabase._state.team_members[0].availability).toBeNull();
  });

  test('no ZB-linked territories → skipped_no_territories', async () => {
    const supabase = makeSupabase({
      team_members: [{ id: 1, user_id: 2, zenbooker_id: 'zb_prov_1', territories: [999], availability: null }],
    });
    const zbFetchFn = jest.fn();
    const result = await reconcileTeamMemberAvailability({
      supabase,
      teamMember: supabase._state.team_members[0],
      territoriesLookup: baseTerritoryLookup,
      apiKey: 'k',
      dryRun: false,
      zbFetchFn,
      logger: quietLogger(),
    });
    expect(result.action).toBe('skipped_no_territories');
    expect(zbFetchFn).not.toHaveBeenCalled();
  });

  test('no zenbooker_id → skipped_no_zb_id', async () => {
    const supabase = makeSupabase({
      team_members: [{ id: 1, user_id: 2, zenbooker_id: null, territories: [10], availability: null }],
    });
    const zbFetchFn = jest.fn();
    const result = await reconcileTeamMemberAvailability({
      supabase,
      teamMember: supabase._state.team_members[0],
      territoriesLookup: baseTerritoryLookup,
      apiKey: 'k',
      dryRun: false,
      zbFetchFn,
      logger: quietLogger(),
    });
    expect(result.action).toBe('skipped_no_zb_id');
    expect(zbFetchFn).not.toHaveBeenCalled();
  });

  test('dry-run does not write', async () => {
    const supabase = makeSupabase({
      team_members: [{ id: 1, user_id: 2, zenbooker_id: 'zb_prov_1', territories: [10], availability: null }],
    });
    const zbFetchFn = jest.fn().mockResolvedValue({
      days: [{ date: '2026-08-11', timeslots: [{ start: '2026-08-11T09:00:00', end: '2026-08-11T17:00:00' }] }],
    });
    const result = await reconcileTeamMemberAvailability({
      supabase,
      teamMember: supabase._state.team_members[0],
      territoriesLookup: baseTerritoryLookup,
      apiKey: 'k',
      dryRun: true,
      zbFetchFn,
      logger: quietLogger(),
    });
    expect(result.action).toBe('would_write');
    expect(result.datesWritten).toBe(1);
    expect(supabase._state.team_members[0].availability).toBeNull();
  });

  test('idempotent — second pass with same /timeslots → no_change', async () => {
    const supabase = makeSupabase({
      team_members: [{ id: 1, user_id: 2, zenbooker_id: 'zb_prov_1', territories: [10], availability: null }],
    });
    const timeslotResp = {
      days: [{ date: '2026-08-11', timeslots: [{ start: '2026-08-11T09:00:00', end: '2026-08-11T17:00:00' }] }],
    };
    const zbFetchFn = jest.fn().mockResolvedValue(timeslotResp);

    await reconcileTeamMemberAvailability({
      supabase,
      teamMember: supabase._state.team_members[0],
      territoriesLookup: baseTerritoryLookup,
      apiKey: 'k',
      dryRun: false,
      zbFetchFn,
      logger: quietLogger(),
    });
    const result2 = await reconcileTeamMemberAvailability({
      supabase,
      teamMember: supabase._state.team_members[0],
      territoriesLookup: baseTerritoryLookup,
      apiKey: 'k',
      dryRun: false,
      zbFetchFn,
      logger: quietLogger(),
    });
    expect(result2.action).toBe('no_change');
  });

  test('preserves weekly schedule keys (monday..sunday) through write', async () => {
    const supabase = makeSupabase({
      team_members: [{
        id: 1, user_id: 2, zenbooker_id: 'zb_prov_1', territories: [10],
        availability: {
          monday: { start: '09:00', end: '17:00' },
          tuesday: { start: '10:00', end: '18:00' },
          customAvailability: [],
        },
      }],
    });
    const zbFetchFn = jest.fn().mockResolvedValue({
      days: [{ date: '2026-08-11', timeslots: [{ start: '2026-08-11T09:00:00', end: '2026-08-11T17:00:00' }] }],
    });
    await reconcileTeamMemberAvailability({
      supabase,
      teamMember: supabase._state.team_members[0],
      territoriesLookup: baseTerritoryLookup,
      apiKey: 'k',
      dryRun: false,
      zbFetchFn,
      logger: quietLogger(),
    });
    const written = supabase._state.team_members[0].availability;
    expect(written.monday).toEqual({ start: '09:00', end: '17:00' });
    expect(written.tuesday).toEqual({ start: '10:00', end: '18:00' });
    expect(written.customAvailability).toHaveLength(1);
  });

  test('preserves manual customAvailability entries through write', async () => {
    const supabase = makeSupabase({
      team_members: [{
        id: 1, user_id: 2, zenbooker_id: 'zb_prov_1', territories: [10],
        availability: {
          customAvailability: [{ date: '2026-08-25', available: false }],
        },
      }],
    });
    const zbFetchFn = jest.fn().mockResolvedValue({
      days: [{ date: '2026-08-11', timeslots: [{ start: '2026-08-11T09:00:00', end: '2026-08-11T17:00:00' }] }],
    });
    await reconcileTeamMemberAvailability({
      supabase,
      teamMember: supabase._state.team_members[0],
      territoriesLookup: baseTerritoryLookup,
      apiKey: 'k',
      dryRun: false,
      zbFetchFn,
      logger: quietLogger(),
    });
    const written = supabase._state.team_members[0].availability.customAvailability;
    const manual = written.find(e => e.date === '2026-08-25');
    expect(manual).toEqual({ date: '2026-08-25', available: false });
    const zb = written.find(e => e.date === '2026-08-11');
    expect(zb.source).toBe(ZB_SOURCE_MARKER);
  });
});

// ── reconcileTenantAvailability (sweep) ────────────────────────────

describe('reconcileTenantAvailability', () => {
  test('scans only ZB-linked team_members for the tenant', async () => {
    const supabase = makeSupabase({
      team_members: [
        { id: 1, user_id: 2, zenbooker_id: 'zb_prov_1', territories: [10], availability: null },
        { id: 2, user_id: 2, zenbooker_id: null, territories: [10], availability: null }, // skipped: no ZB id
        { id: 3, user_id: 99, zenbooker_id: 'zb_prov_x', territories: [10], availability: null }, // wrong tenant
      ],
      territories: [{ id: 10, user_id: 2, zenbooker_id: 'zb_terr_a' }],
    });
    const zbFetchFn = jest.fn().mockResolvedValue({
      days: [{ date: '2026-08-11', timeslots: [{ start: '2026-08-11T09:00:00', end: '2026-08-11T17:00:00' }] }],
    });
    const { summary } = await reconcileTenantAvailability({
      supabase,
      userId: 2,
      apiKey: 'k',
      dryRun: false,
      perProviderDelayMs: 0,
      zbFetchFn,
      logger: quietLogger(),
    });
    expect(summary.scanned).toBe(1);
    expect(summary.written).toBe(1);
    // Wrong-tenant row untouched
    expect(supabase._state.team_members.find(t => t.id === 3).availability).toBeNull();
  });

  test('one team member failure does not abort tenant sweep', async () => {
    const supabase = makeSupabase({
      team_members: [
        { id: 1, user_id: 2, zenbooker_id: 'zb_prov_1', territories: [10], availability: null },
        { id: 2, user_id: 2, zenbooker_id: 'zb_prov_2', territories: [10], availability: null },
      ],
      territories: [{ id: 10, user_id: 2, zenbooker_id: 'zb_terr_a' }],
    });
    let call = 0;
    const zbFetchFn = jest.fn().mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error('Zenbooker API 500');
      return {
        days: [{ date: '2026-08-11', timeslots: [{ start: '2026-08-11T09:00:00', end: '2026-08-11T17:00:00' }] }],
      };
    });
    const { summary } = await reconcileTenantAvailability({
      supabase,
      userId: 2,
      apiKey: 'k',
      dryRun: false,
      perProviderDelayMs: 0,
      zbFetchFn,
      logger: quietLogger(),
    });
    expect(summary.scanned).toBe(2);
    expect(summary.skipped_fetch_failed).toBe(1);
    expect(summary.written).toBe(1);
  });
});
