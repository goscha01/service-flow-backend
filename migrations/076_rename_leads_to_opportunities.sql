-- ============================================================================
-- Migration 076: Rename Lead → Opportunity (CRM semantic rename)
--
-- ServiceFlow renames its CRM "Lead" concept to "Opportunity" to better
-- reflect the sale-cycle semantics (an opportunity is a potential sale being
-- managed; it may come from LeadBridge, phone calls, referrals, forms, etc.).
--
-- Preserved (NOT renamed):
--   - LeadBridge terminology: leadbridge_*, lb_*, lb_lead_id (external UUID),
--     jobs/customers.lb_lead_id, communication_settings.leadbridge_lead_status_*,
--     leadbridge_outbound_events, communication_conversations.external_lead_id.
--   - crm_lead_id on communication_participant_mappings — retained as-is (see
--     rationale at bottom).
--
-- Renames (this migration):
--   public.leads                                → public.opportunities
--   public.lead_pipelines                       → public.opportunity_pipelines
--   public.lead_stages                          → public.opportunity_stages
--   public.lead_tasks                           → public.opportunity_tasks
--   public.lead_sources                         → public.opportunity_sources
--   public.lead_source_mappings                 → public.opportunity_source_mappings
--   public.lead_stage_automation_rules          → public.opportunity_stage_automation_rules
--   public.communication_openphone_lead_decisions
--     → public.communication_openphone_opportunity_decisions
--   sf_staging.leads / lead_pipelines / lead_tasks / lead_sources / lead_source_mappings
--     → sf_staging.opportunit... equivalents
--
-- Columns:
--   opportunities.parent_lead_id            → parent_opportunity_id
--   opportunities.lead_origin_type          → opportunity_origin_type
--   opportunities.canonical_lead_id         → canonical_opportunity_id (generated; DROP+READD)
--   opportunities.lead_cost                 → opportunity_cost
--   opportunity_tasks.lead_id               → opportunity_id
--   communication_openphone_opportunity_decisions.lead_id → opportunity_id
--
-- Backward-compat: legacy read-only VIEWs are created so any straggling
-- `SELECT ... FROM leads` in the app or ad-hoc scripts keeps working. The
-- app code itself is switched to the new names in the same deploy.
-- ============================================================================

BEGIN;

-- ── 1. Rename tables ──────────────────────────────────────────────────────
ALTER TABLE IF EXISTS public.leads                                  RENAME TO opportunities;
ALTER TABLE IF EXISTS public.lead_pipelines                         RENAME TO opportunity_pipelines;
ALTER TABLE IF EXISTS public.lead_stages                            RENAME TO opportunity_stages;
ALTER TABLE IF EXISTS public.lead_tasks                             RENAME TO opportunity_tasks;
ALTER TABLE IF EXISTS public.lead_sources                           RENAME TO opportunity_sources;
ALTER TABLE IF EXISTS public.lead_source_mappings                   RENAME TO opportunity_source_mappings;
ALTER TABLE IF EXISTS public.lead_stage_automation_rules            RENAME TO opportunity_stage_automation_rules;
ALTER TABLE IF EXISTS public.communication_openphone_lead_decisions RENAME TO communication_openphone_opportunity_decisions;

-- Staging schema mirror (created via migration 071).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'sf_staging') THEN
    EXECUTE 'ALTER TABLE IF EXISTS sf_staging.leads               RENAME TO opportunities';
    EXECUTE 'ALTER TABLE IF EXISTS sf_staging.lead_pipelines      RENAME TO opportunity_pipelines';
    EXECUTE 'ALTER TABLE IF EXISTS sf_staging.lead_tasks          RENAME TO opportunity_tasks';
    EXECUTE 'ALTER TABLE IF EXISTS sf_staging.lead_sources        RENAME TO opportunity_sources';
    EXECUTE 'ALTER TABLE IF EXISTS sf_staging.lead_source_mappings RENAME TO opportunity_source_mappings';
  END IF;
END $$;

-- ── 2. Rename columns on opportunities (was leads) ────────────────────────
-- Drop the generated canonical_lead_id column first (generated columns cannot
-- reference renamed columns automatically).
ALTER TABLE public.opportunities DROP COLUMN IF EXISTS canonical_lead_id;

ALTER TABLE public.opportunities RENAME COLUMN parent_lead_id     TO parent_opportunity_id;
ALTER TABLE public.opportunities RENAME COLUMN lead_origin_type   TO opportunity_origin_type;
ALTER TABLE public.opportunities RENAME COLUMN lead_cost          TO opportunity_cost;

-- Re-add generated column pointing at the new column name.
ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS canonical_opportunity_id INTEGER
    GENERATED ALWAYS AS (COALESCE(parent_opportunity_id, id)) STORED;

COMMENT ON COLUMN public.opportunities.parent_opportunity_id IS
  'When set, this opportunity is a child acquisition event of opportunities.id=parent_opportunity_id. Pipeline lifecycle lives on the canonical (parent_opportunity_id IS NULL). Children preserve their own source / opportunity_cost / created_at / attribution. Same-tenant constraint enforced in application code. ON DELETE SET NULL keeps acquisition records when canonical is deleted.';

COMMENT ON COLUMN public.opportunities.opportunity_origin_type IS
  'Acquisition provenance tag, written by LB ingest at creation. first_touch / repeat_acquisition / reactivation. NULL on historical rows pre-Phase-0.5 (treated as first_touch by analytics).';

COMMENT ON COLUMN public.opportunities.canonical_opportunity_id IS
  'Generated: COALESCE(parent_opportunity_id, id). The canonical opportunity for this row. Use for GROUP BY in person-level aggregation.';

-- ── 3. Rename CHECK constraint on opportunity_origin_type ────────────────
ALTER TABLE public.opportunities
  DROP CONSTRAINT IF EXISTS leads_lead_origin_type_check;

ALTER TABLE public.opportunities
  ADD CONSTRAINT opportunities_opportunity_origin_type_check CHECK (
    opportunity_origin_type IS NULL
    OR opportunity_origin_type IN ('first_touch', 'repeat_acquisition', 'reactivation')
  );

-- ── 4. Rename FK columns on child tables ─────────────────────────────────
ALTER TABLE IF EXISTS public.opportunity_tasks
  RENAME COLUMN lead_id TO opportunity_id;

ALTER TABLE IF EXISTS public.communication_openphone_opportunity_decisions
  RENAME COLUMN lead_id TO opportunity_id;

-- ── 5. Rename indices ────────────────────────────────────────────────────
ALTER INDEX IF EXISTS public.idx_leads_user_canonical
  RENAME TO idx_opportunities_user_canonical;
ALTER INDEX IF EXISTS public.idx_leads_parent
  RENAME TO idx_opportunities_parent;
ALTER INDEX IF EXISTS public.idx_leads_user_canonical_pipeline
  RENAME TO idx_opportunities_user_canonical_pipeline;
ALTER INDEX IF EXISTS public.idx_leads_user_source_raw
  RENAME TO idx_opportunities_user_source_raw;
ALTER INDEX IF EXISTS public.idx_leads_user_lb_external_request_id
  RENAME TO idx_opportunities_user_lb_external_request_id;
ALTER INDEX IF EXISTS public.idx_leads_converted_customer_lb
  RENAME TO idx_opportunities_converted_customer_lb;

ALTER INDEX IF EXISTS public.idx_lead_sources_user_name
  RENAME TO idx_opportunity_sources_user_name;

ALTER INDEX IF EXISTS public.idx_lead_source_map_user_raw
  RENAME TO idx_opportunity_source_map_user_raw;

ALTER INDEX IF EXISTS public.idx_lsar_unique_rule
  RENAME TO idx_osar_unique_rule;
ALTER INDEX IF EXISTS public.idx_lsar_user
  RENAME TO idx_osar_user;

ALTER INDEX IF EXISTS public.idx_op_lead_decisions_user_created
  RENAME TO idx_op_opportunity_decisions_user_created;
ALTER INDEX IF EXISTS public.idx_op_lead_decisions_user_outcome_created
  RENAME TO idx_op_opportunity_decisions_user_outcome_created;

-- ── 6. Rename CHECK constraint on openphone decisions outcome ───────────
ALTER TABLE public.communication_openphone_opportunity_decisions
  DROP CONSTRAINT IF EXISTS op_lead_decisions_outcome_check;

ALTER TABLE public.communication_openphone_opportunity_decisions
  ADD CONSTRAINT op_opportunity_decisions_outcome_check CHECK (outcome IN (
    'created_lead_openphone_direct',
    'created_lead_openphone_lb_recovery',
    'linked_existing_customer_by_phone',
    'linked_existing_lead_by_phone',
    'skipped_missing_company',
    'skipped_out_of_age_window',
    'skipped_lb_owned_already_ingested',
    'skipped_identity_has_lead',
    'skipped_identity_has_customer',
    'skipped_aggregator_name',
    'skipped_noise_no_name'
  ));

-- ── 7. Rename trigger on opportunity_stage_automation_rules ─────────────
DROP TRIGGER IF EXISTS trg_lsar_updated_at ON public.opportunity_stage_automation_rules;
CREATE TRIGGER trg_osar_updated_at
  BEFORE UPDATE ON public.opportunity_stage_automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 8. Extend import_mapping_presets.target to accept 'opportunities' ───
-- 'leads' remains valid for backward compatibility with existing preset rows.
ALTER TABLE public.import_mapping_presets
  DROP CONSTRAINT IF EXISTS import_mapping_presets_target_check;

ALTER TABLE public.import_mapping_presets
  ADD CONSTRAINT import_mapping_presets_target_check
  CHECK (target IN ('customers','leads','opportunities','jobs','team_members','services','territories'));

-- ── 9. Backward-compat read-only VIEWs (public schema) ──────────────────
-- Any lingering `from('leads')` in scripts, ad-hoc SQL, or non-updated code
-- keeps working. New app code targets opportunities directly.
CREATE OR REPLACE VIEW public.leads AS
  SELECT
    o.*,
    o.parent_opportunity_id     AS parent_lead_id,
    o.opportunity_origin_type   AS lead_origin_type,
    o.canonical_opportunity_id  AS canonical_lead_id,
    o.opportunity_cost          AS lead_cost
  FROM public.opportunities o;

CREATE OR REPLACE VIEW public.lead_pipelines             AS SELECT * FROM public.opportunity_pipelines;
CREATE OR REPLACE VIEW public.lead_stages                AS SELECT * FROM public.opportunity_stages;
CREATE OR REPLACE VIEW public.lead_tasks                 AS
  SELECT t.*, t.opportunity_id AS lead_id FROM public.opportunity_tasks t;
CREATE OR REPLACE VIEW public.lead_sources               AS SELECT * FROM public.opportunity_sources;
CREATE OR REPLACE VIEW public.lead_source_mappings       AS SELECT * FROM public.opportunity_source_mappings;
CREATE OR REPLACE VIEW public.lead_stage_automation_rules AS SELECT * FROM public.opportunity_stage_automation_rules;
CREATE OR REPLACE VIEW public.communication_openphone_lead_decisions AS
  SELECT d.*, d.opportunity_id AS lead_id
  FROM public.communication_openphone_opportunity_decisions d;

COMMENT ON VIEW public.leads IS
  'Backward-compat view (migration 076). Reads from public.opportunities; exposes legacy column aliases (parent_lead_id, lead_origin_type, canonical_lead_id, lead_cost). Read-only. New code should target public.opportunities directly.';

-- ── Notes on retained "lead" names (intentional) ────────────────────────
-- 1. communication_conversations.external_lead_id  — external provider id
--    (Thumbtack request id, Yelp lead id). This is the provider's own term,
--    not our CRM entity. Kept.
-- 2. communication_participant_mappings.crm_lead_id — retained as a stable
--    identifier column. Rename is safe to defer to a follow-up migration.
-- 3. communication_participant_identities.sf_lead_id — retained; rename
--    deferred to a follow-up (touches the identity graph write-path RPCs
--    in migrations 026 / 047).
-- 4. identity_link_audit.lead_id — retained; append-only audit table where
--    historic rows already carry this name, deferred to follow-up.
-- 5. All leadbridge_*, lb_*, jobs.lb_lead_id, customers.lb_lead_id → LeadBridge
--    terminology, unchanged by design.

NOTIFY pgrst, 'reload schema';

COMMIT;
