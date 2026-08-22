-- 082 — marketing_spend + opportunities.budget_voided_at
--
-- Normalized marketing-spend model. Distinct from business_expenses
-- (mig 081, tenant overhead like rent/SaaS/insurance) — this table
-- captures acquisition/advertising economics per channel per period.
--
-- Design invariants:
--   • Spend is stored. CPL/CAC/ROAS are derived at read time.
--   • Effective vs reported: amount_cents is what Analytics uses;
--     reported_amount_cents is what upstream (LB/scrape/API) said.
--     Manual override sets is_manual_override=true and pins amount_cents;
--     subsequent sync updates reported_amount_cents without touching
--     amount_cents.
--   • Thumbtack rows are DERIVED monthly from opportunities.opportunity_cost
--     (source_type = 'derived_from_opportunities') — the ONE canonical TT
--     aggregation path. Analytics reads ONLY from marketing_spend; never
--     re-sums opportunity_cost independently.
--   • Yelp/Google/Meta/LSA rows are per-period, entered manually or pulled
--     from a future upstream. When Yelp auto-sync ships later, its
--     synced value flows into reported_amount_cents; manual override
--     wins in amount_cents.
--
-- Unknown spend ≠ $0. No row = no spend data (Analytics must present
-- as em-dash, not zero). CPL/CAC/ROAS return null for unknown-spend
-- periods.

CREATE TABLE IF NOT EXISTS public.marketing_spend (
  id                     bigserial PRIMARY KEY,
  user_id                integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source                 text    NOT NULL,       -- 'thumbtack' | 'yelp' | 'google_ads' | 'meta_ads' | 'google_lsa' | 'other'
  period_start           date    NOT NULL,       -- month start (day 1)
  period_end             date    NOT NULL,       -- last day of month
  amount_cents           bigint  NOT NULL CHECK (amount_cents >= 0),  -- effective spend Analytics uses
  reported_amount_cents  bigint  CHECK (reported_amount_cents IS NULL OR reported_amount_cents >= 0),  -- what upstream reported; null if never imported
  is_manual_override     boolean NOT NULL DEFAULT false,
  source_type            text    NOT NULL CHECK (source_type IN
                             ('leadbridge','api','scrape','manual','derived_from_opportunities')),
  external_account_id    text,                    -- e.g. LB provider_account_id for multi-TT tenants
  external_campaign_id   text,                    -- Google/Meta campaign id for later
  metadata               jsonb,                   -- raw upstream payload for debugging/audit
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

-- One row per (tenant, source, period, account). Partial indexes avoid
-- COALESCE-in-UNIQUE gotchas: NULL external_account_id has its own slot.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketing_spend_no_account
  ON public.marketing_spend (user_id, source, period_start)
  WHERE external_account_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketing_spend_with_account
  ON public.marketing_spend (user_id, source, period_start, external_account_id)
  WHERE external_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_spend_user_period
  ON public.marketing_spend (user_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_marketing_spend_user_source
  ON public.marketing_spend (user_id, source);

COMMENT ON TABLE public.marketing_spend IS
  'Per-tenant marketing/advertising spend by channel and period. Thumbtack derived from opportunities.opportunity_cost; Yelp/Google/Meta manual or imported. Effective (amount_cents) vs reported (reported_amount_cents) distinction preserves manual overrides across upstream re-syncs.';

COMMENT ON COLUMN public.marketing_spend.amount_cents IS
  'Effective spend used by Analytics. Cents, integer, avoids float drift.';

COMMENT ON COLUMN public.marketing_spend.reported_amount_cents IS
  'Amount most-recently reported by upstream (LB sync, scrape, API). Null if never synced (pure manual entry). Preserved across manual overrides.';

COMMENT ON COLUMN public.marketing_spend.is_manual_override IS
  'True when the user has edited amount_cents. Upstream sync must NOT overwrite amount_cents while true; only reported_amount_cents updates.';

COMMENT ON COLUMN public.marketing_spend.source_type IS
  'Provenance of the effective amount. derived_from_opportunities = TT materialization; manual = user typed; leadbridge/api/scrape = upstream import.';

-- ═══════════════════════════════════════════════════════════════════════
-- opportunities.budget_voided_at
-- Mirror LB's refund gate. When set, opportunity_cost is EXCLUDED from
-- TT spend materialization. Semantics identical to LB's Lead.budgetVoidedAt:
-- refund detected atomically at ingestion or explicitly marked by
-- operator. opportunity_cost value stays intact for auditability; the
-- gate is what drives Analytics exclusion.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS budget_voided_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_opportunities_budget_voided_partial
  ON public.opportunities (user_id, source, created_at)
  WHERE budget_voided_at IS NULL AND opportunity_cost IS NOT NULL;

COMMENT ON COLUMN public.opportunities.budget_voided_at IS
  'Refund/void gate mirroring LB Lead.budgetVoidedAt. When non-null, this opportunity''s opportunity_cost is EXCLUDED from marketing_spend materialization. Populated by LB webhook when the platform reports a refund; can also be set manually by operator. opportunity_cost value is retained for audit.';

-- RLS on, no policies — matches project convention (mig 071).
ALTER TABLE public.marketing_spend ENABLE ROW LEVEL SECURITY;
