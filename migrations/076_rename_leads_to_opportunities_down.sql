-- Down migration for 076_rename_leads_to_opportunities.sql
-- Reverses the Lead → Opportunity semantic rename.

BEGIN;

DROP VIEW IF EXISTS public.leads;
DROP VIEW IF EXISTS public.lead_pipelines;
DROP VIEW IF EXISTS public.lead_stages;
DROP VIEW IF EXISTS public.lead_tasks;
DROP VIEW IF EXISTS public.lead_sources;
DROP VIEW IF EXISTS public.lead_source_mappings;
DROP VIEW IF EXISTS public.lead_stage_automation_rules;
DROP VIEW IF EXISTS public.communication_openphone_lead_decisions;

-- Rename constraints back.
ALTER TABLE public.communication_openphone_opportunity_decisions
  DROP CONSTRAINT IF EXISTS op_opportunity_decisions_outcome_check;

ALTER TABLE public.opportunities
  DROP CONSTRAINT IF EXISTS opportunities_opportunity_origin_type_check;

-- Rename indices back.
ALTER INDEX IF EXISTS public.idx_opportunities_user_canonical
  RENAME TO idx_leads_user_canonical;
ALTER INDEX IF EXISTS public.idx_opportunities_parent
  RENAME TO idx_leads_parent;
ALTER INDEX IF EXISTS public.idx_opportunities_user_canonical_pipeline
  RENAME TO idx_leads_user_canonical_pipeline;
ALTER INDEX IF EXISTS public.idx_opportunities_user_source_raw
  RENAME TO idx_leads_user_source_raw;
ALTER INDEX IF EXISTS public.idx_opportunities_user_lb_external_request_id
  RENAME TO idx_leads_user_lb_external_request_id;
ALTER INDEX IF EXISTS public.idx_opportunities_converted_customer_lb
  RENAME TO idx_leads_converted_customer_lb;
ALTER INDEX IF EXISTS public.idx_opportunity_sources_user_name
  RENAME TO idx_lead_sources_user_name;
ALTER INDEX IF EXISTS public.idx_opportunity_source_map_user_raw
  RENAME TO idx_lead_source_map_user_raw;
ALTER INDEX IF EXISTS public.idx_osar_unique_rule
  RENAME TO idx_lsar_unique_rule;
ALTER INDEX IF EXISTS public.idx_osar_user
  RENAME TO idx_lsar_user;
ALTER INDEX IF EXISTS public.idx_op_opportunity_decisions_user_created
  RENAME TO idx_op_lead_decisions_user_created;
ALTER INDEX IF EXISTS public.idx_op_opportunity_decisions_user_outcome_created
  RENAME TO idx_op_lead_decisions_user_outcome_created;

-- Rename trigger back.
DROP TRIGGER IF EXISTS trg_osar_updated_at ON public.opportunity_stage_automation_rules;

-- Rename FK columns back.
ALTER TABLE IF EXISTS public.communication_openphone_opportunity_decisions
  RENAME COLUMN opportunity_id TO lead_id;

ALTER TABLE IF EXISTS public.opportunity_tasks
  RENAME COLUMN opportunity_id TO lead_id;

-- Rename opportunity columns back (generated column drop first).
ALTER TABLE public.opportunities DROP COLUMN IF EXISTS canonical_opportunity_id;

ALTER TABLE public.opportunities RENAME COLUMN opportunity_cost         TO lead_cost;
ALTER TABLE public.opportunities RENAME COLUMN opportunity_origin_type  TO lead_origin_type;
ALTER TABLE public.opportunities RENAME COLUMN parent_opportunity_id    TO parent_lead_id;

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS canonical_lead_id INTEGER
    GENERATED ALWAYS AS (COALESCE(parent_lead_id, id)) STORED;

-- Rename tables back.
ALTER TABLE IF EXISTS public.communication_openphone_opportunity_decisions RENAME TO communication_openphone_lead_decisions;
ALTER TABLE IF EXISTS public.opportunity_stage_automation_rules            RENAME TO lead_stage_automation_rules;
ALTER TABLE IF EXISTS public.opportunity_source_mappings                   RENAME TO lead_source_mappings;
ALTER TABLE IF EXISTS public.opportunity_sources                           RENAME TO lead_sources;
ALTER TABLE IF EXISTS public.opportunity_tasks                             RENAME TO lead_tasks;
ALTER TABLE IF EXISTS public.opportunity_stages                            RENAME TO lead_stages;
ALTER TABLE IF EXISTS public.opportunity_pipelines                         RENAME TO lead_pipelines;
ALTER TABLE IF EXISTS public.opportunities                                 RENAME TO leads;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'sf_staging') THEN
    EXECUTE 'ALTER TABLE IF EXISTS sf_staging.opportunity_source_mappings RENAME TO lead_source_mappings';
    EXECUTE 'ALTER TABLE IF EXISTS sf_staging.opportunity_sources         RENAME TO lead_sources';
    EXECUTE 'ALTER TABLE IF EXISTS sf_staging.opportunity_tasks           RENAME TO lead_tasks';
    EXECUTE 'ALTER TABLE IF EXISTS sf_staging.opportunity_pipelines       RENAME TO lead_pipelines';
    EXECUTE 'ALTER TABLE IF EXISTS sf_staging.opportunities               RENAME TO leads';
  END IF;
END $$;

-- Re-add original CHECK constraints (with legacy names).
ALTER TABLE public.leads
  ADD CONSTRAINT leads_lead_origin_type_check CHECK (
    lead_origin_type IS NULL OR lead_origin_type IN ('first_touch', 'repeat_acquisition', 'reactivation')
  );

ALTER TABLE public.communication_openphone_lead_decisions
  ADD CONSTRAINT op_lead_decisions_outcome_check CHECK (outcome IN (
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

-- Recreate original trigger.
CREATE TRIGGER trg_lsar_updated_at
  BEFORE UPDATE ON public.lead_stage_automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Revert import_mapping_presets check.
ALTER TABLE public.import_mapping_presets
  DROP CONSTRAINT IF EXISTS import_mapping_presets_target_check;
ALTER TABLE public.import_mapping_presets
  ADD CONSTRAINT import_mapping_presets_target_check
  CHECK (target IN ('customers','leads','jobs','team_members','services','territories'));

NOTIFY pgrst, 'reload schema';

COMMIT;
