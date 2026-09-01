'use strict';

/**
 * Marketing-spend contract tests for lib/lb-ingestion.js.
 *
 * Covers spec cases:
 *   1. LB Thumbtack lead with leadPriceCents → SF opportunity_cost
 *   2. LB lead without cost → SF remains null
 *   5. Existing SF opportunity_cost is not overwritten by enrich
 *   +  boundary conversion cents→dollars is deterministic
 *   +  budgetVoidedAt is a REFRESH (not fill-only)
 *   +  refund clear (LB → null) reflects in SF
 */

const { pickLbSpend, buildEnrichLeadPatch } = require('../lib/lb-ingestion');

describe('pickLbSpend — LB spend/refund field extraction (spec §3)', () => {
  test('extracts leadPriceCents and converts to dollars', () => {
    // Case 1: real Thumbtack cost
    expect(pickLbSpend({ leadPriceCents: 4200 })).toEqual({
      opportunity_cost: 42,           // 4200 cents ÷ 100 = 42.00 dollars
      budget_voided_at: null,
    });
  });

  test('returns nulls when leadPriceCents is missing', () => {
    // Case 2: no cost data on the wire
    expect(pickLbSpend({})).toEqual({
      opportunity_cost: null,
      budget_voided_at: null,
    });
  });

  test('accepts integer cents up to the cent (no rounding drift)', () => {
    // Spec: use cents internally, avoid float drift.
    expect(pickLbSpend({ leadPriceCents: 4299 }).opportunity_cost).toBeCloseTo(42.99, 2);
    expect(pickLbSpend({ leadPriceCents: 1 }).opportunity_cost).toBeCloseTo(0.01, 2);
    expect(pickLbSpend({ leadPriceCents: 0 }).opportunity_cost).toBe(0);
  });

  test('rejects negative or NaN cents', () => {
    expect(pickLbSpend({ leadPriceCents: -100 }).opportunity_cost).toBeNull();
    expect(pickLbSpend({ leadPriceCents: 'abc' }).opportunity_cost).toBeNull();
    expect(pickLbSpend({ leadPriceCents: null }).opportunity_cost).toBeNull();
  });

  test('parses budgetVoidedAt to ISO string', () => {
    const out = pickLbSpend({ budgetVoidedAt: '2026-05-01T10:00:00Z' });
    expect(out.budget_voided_at).toBe('2026-05-01T10:00:00.000Z');
  });

  test('returns null for invalid budgetVoidedAt', () => {
    expect(pickLbSpend({ budgetVoidedAt: 'nope' }).budget_voided_at).toBeNull();
  });
});

describe('buildEnrichLeadPatch — spend fields (spec §5, §3)', () => {
  const baseInput = {
    channel: 'thumbtack',
    accountDisplayName: 'St Pete TT',
  };

  test('fills opportunity_cost when existing is null and LB provides it', () => {
    const patch = buildEnrichLeadPatch({
      existing: { opportunity_cost: null },
      input: { ...baseInput, leadPriceCents: 4200 },
    });
    expect(patch.opportunity_cost).toBe(42);
  });

  test('does NOT overwrite non-null opportunity_cost (case 5, hard rule)', () => {
    // The user spec: "Do not overwrite an existing valid opportunity cost
    // unless the audit shows it is safe/necessary." Enrich must respect that.
    const patch = buildEnrichLeadPatch({
      existing: { opportunity_cost: 35.5 },
      input: { ...baseInput, leadPriceCents: 9999 },
    });
    // Patch is either null OR has no opportunity_cost key.
    if (patch) {
      expect(patch.opportunity_cost).toBeUndefined();
    }
  });

  test('does NOT set opportunity_cost when both existing and incoming are null', () => {
    const patch = buildEnrichLeadPatch({
      existing: { opportunity_cost: null },
      input: baseInput,
    });
    if (patch) expect(patch.opportunity_cost).toBeUndefined();
  });

  test('refreshes budget_voided_at when LB reports a new void (state, not fill-only)', () => {
    const patch = buildEnrichLeadPatch({
      existing: { budget_voided_at: null },
      input: { ...baseInput, budgetVoidedAt: '2026-05-01T10:00:00Z' },
    });
    expect(patch.budget_voided_at).toBe('2026-05-01T10:00:00.000Z');
  });

  test('clears budget_voided_at when LB flips it back to null (un-void)', () => {
    const patch = buildEnrichLeadPatch({
      existing: { budget_voided_at: '2026-05-01T10:00:00.000Z' },
      input: baseInput,     // no budgetVoidedAt on input
    });
    // pickLbSpend returns null; enrich reflects the delta.
    expect(patch.budget_voided_at).toBeNull();
  });

  test('is idempotent — second enrich with same input is a no-op (case 4)', () => {
    const existing = { opportunity_cost: 42, budget_voided_at: '2026-05-01T10:00:00.000Z' };
    const input = { ...baseInput, leadPriceCents: 4200, budgetVoidedAt: '2026-05-01T10:00:00Z' };
    const patch = buildEnrichLeadPatch({ existing, input });
    if (patch) {
      expect(patch.opportunity_cost).toBeUndefined();
      expect(patch.budget_voided_at).toBeUndefined();
    }
  });
});
