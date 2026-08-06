# Lead → Opportunity Rename (Migration 076)

**Status**: Applied.
**Migration**: [`migrations/076_rename_leads_to_opportunities.sql`](../../migrations/076_rename_leads_to_opportunities.sql)
**Rollback**: `076_rename_leads_to_opportunities_down.sql`

## What changed

The CRM concept previously called `Lead` in ServiceFlow is now `Opportunity`. An Opportunity represents a potential sale being managed in the CRM. It may originate from any of these sources — the concept is source-agnostic:

- LeadBridge (external marketplace / web leads)
- Manual creation
- Phone calls
- Referrals
- Website forms
- Bulk imports

`Contact` remains the canonical person/company record. `Customer` remains the converted operational entity. A LeadBridge Lead maps to a ServiceFlow Opportunity — the two concepts are distinct across the two products.

## Table map

| Was | Now |
|---|---|
| `leads` | `opportunities` |
| `lead_pipelines` | `opportunity_pipelines` |
| `lead_stages` | `opportunity_stages` |
| `lead_tasks` | `opportunity_tasks` |
| `lead_sources` | `opportunity_sources` |
| `lead_source_mappings` | `opportunity_source_mappings` |
| `lead_stage_automation_rules` | `opportunity_stage_automation_rules` |
| `communication_openphone_lead_decisions` | `communication_openphone_opportunity_decisions` |

Same rename applied under `sf_staging.*` where the mirror tables exist (RLS lockdown, migration 071).

## Column map (on renamed tables only)

| Was | Now |
|---|---|
| `opportunities.parent_lead_id` | `opportunities.parent_opportunity_id` |
| `opportunities.canonical_lead_id` (generated stored) | `opportunities.canonical_opportunity_id` |
| `opportunities.lead_origin_type` | `opportunities.opportunity_origin_type` |
| `opportunities.lead_cost` | `opportunities.opportunity_cost` |
| `opportunity_tasks.lead_id` | `opportunity_tasks.opportunity_id` |
| `communication_openphone_opportunity_decisions.lead_id` | `.opportunity_id` |

## Backward compatibility

- **DB read compat**: legacy views `public.leads`, `public.lead_pipelines`, `public.lead_stages`, `public.lead_tasks`, `public.lead_sources`, `public.lead_source_mappings`, `public.lead_stage_automation_rules`, `public.communication_openphone_lead_decisions` are created by migration 076 as read-only views over the renamed tables. `public.leads` also exposes legacy column aliases (`parent_lead_id`, `lead_origin_type`, `canonical_lead_id`, `lead_cost`) so any script that still `SELECT`s the old names keeps working.
- **API compat**: middleware in `server.js` rewrites legacy URLs before route matching:
  - `/api/leads/*` → `/api/opportunities/*`
  - `/api/lead-sources/*` → `/api/opportunity-sources/*`
  - `/api/lead-source-mappings/*` → `/api/opportunity-source-mappings/*`
  - `/api/lead-automation/*` → `/api/opportunity-automation/*`
  Handlers are registered under the new paths only. `/api/integrations/leadbridge/*` is untouched.
- **Frontend URL compat**: `/leads` and `/lead/:leadId` redirect to `/opportunities` and `/opportunity/:opportunityId` respectively (see `service-flow-frontend/src/index.js`). Settings `/settings/leads` → `/settings/opportunities`.
- **API client compat**: the exports `leadsAPI`, `leadAutomationAPI`, `leadSourcesAPI`, `leadSourceMappingsAPI` in `service-flow-frontend/src/services/api.js` remain as thin aliases of the new `opportunitiesAPI` / `opportunityAutomationAPI` / `opportunitySourcesAPI` / `opportunitySourceMappingsAPI` exports.
- **Import type**: the `POST /api/data-import/import` endpoint accepts both `type: 'leads'` and `type: 'opportunities'` — existing `import_mapping_presets` rows with `target='leads'` continue to work; new rows should use `target='opportunities'`. Both are permitted by the extended CHECK constraint.

## What was NOT renamed (intentional)

LeadBridge is a distinct product. All LeadBridge terminology is preserved:

- All `leadbridge_*` columns and settings
- All `lb_*` prefixes (`lb_lead_id`, `lb_external_request_id`, `lb_channel`, `lb_business_id`, `lb_provider_account_id`)
- `jobs.lb_lead_id`, `customers.lb_lead_id`
- `communication_settings.leadbridge_lead_status_*` columns
- `communication_conversations.external_lead_id` (external provider's ID, e.g. Thumbtack request id / Yelp lead id)
- `communication_participant_identities.sf_lead_id` (deferred — touches identity graph write-path RPCs in migrations 026 / 047)
- `communication_participant_mappings.crm_lead_id`
- `identity_link_audit.lead_id` (append-only audit table)
- The `leadbridge_outbound_events` table
- The `LeadBridgeSemanticDiagnostics.jsx` component
- The `/api/integrations/leadbridge/*` route family
- The `leadbridgeAPI` frontend export
- All `lib/lb-lead-link-*.js` file names and their `LEAD_ONLY` match-type constants (they describe LeadBridge's own linkage taxonomy)

## Follow-up (not blocking this migration)

Renaming `sf_lead_id`, `crm_lead_id`, `identity_link_audit.lead_id`, and `communication_conversations.lead_id` requires touching the identity-graph write path in migrations 026 / 047 (`identity_combine` RPCs, participant-identity setters) and the linker in `lib/identity-linker.js`. Defer to a separate migration that can be reviewed against the identity-graph invariants doc.
