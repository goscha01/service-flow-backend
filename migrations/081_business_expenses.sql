-- 081 — business_expenses
--
-- Non-job business expenses: rent, insurance, SaaS, vehicles, fuel, marketing
-- (non-LB), supplies, utilities, etc. One-off or recurring.
--
-- Distinct from job_expenses (migration 013) — those are per-job cleaner
-- reimbursements that flow into the payroll ledger. business_expenses live
-- outside the ledger and are surfaced only on the analytics Expenses tab.
--
-- Cadence semantics:
--   one_off   — single-date charge (uses start_date only)
--   weekly    — recurs weekly from start_date until end_date (or forever if null)
--   monthly   — recurs monthly from start_date
--   yearly    — recurs yearly from start_date
--
-- Aggregation for a date range is computed on read (analytics endpoint), not
-- materialized. Keeps the schema simple; volumes are small (dozens of rows
-- per tenant).

CREATE TABLE IF NOT EXISTS public.business_expenses (
  id             bigserial PRIMARY KEY,
  user_id        integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  amount         numeric(12, 2) NOT NULL CHECK (amount >= 0),
  category       text NOT NULL DEFAULT 'other',
  cadence        text NOT NULL DEFAULT 'one_off'
                   CHECK (cadence IN ('one_off', 'weekly', 'monthly', 'yearly')),
  start_date     date NOT NULL,
  end_date       date,
  note           text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_expenses_user_id
  ON public.business_expenses(user_id);

CREATE INDEX IF NOT EXISTS idx_business_expenses_user_active
  ON public.business_expenses(user_id, is_active)
  WHERE is_active = true;

COMMENT ON TABLE public.business_expenses IS
  'Tenant business expenses shown on analytics Expenses tab. Distinct from job_expenses (per-job reimbursements) — these are overhead: rent, insurance, SaaS, marketing (non-LB), etc. Cadence + start/end define occurrence in a date range.';

COMMENT ON COLUMN public.business_expenses.cadence IS
  'one_off | weekly | monthly | yearly. Aggregation for a date range multiplies amount by the number of occurrences whose date falls in the range.';

-- RLS on, no policies — matches project convention (mig 071). Backend uses
-- SUPABASE_SERVICE_ROLE_KEY which bypasses RLS. anon/authenticated keys
-- are denied by default.
ALTER TABLE public.business_expenses ENABLE ROW LEVEL SECURITY;
