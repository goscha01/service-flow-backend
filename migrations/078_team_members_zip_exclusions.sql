-- 078 — team_members.zip_exclusions
--
-- Per-member ZIP exclusion list. When a team member is on a territory
-- but shouldn't be routed to certain ZIPs within it (e.g., lives in
-- north Tampa and won't drive to south Tampa), those ZIPs go here.
--
-- Enforcement: the availability engine (server.js#eligibleWorkers)
-- hard-blocks members whose zip_exclusions contains the job's
-- service_address_zip. Manual assignment stays allowed with a warning
-- surfaced to the operator.
--
-- Global (not per-territory) — cross-territory ZIP overlaps are
-- already flagged in the ZIP manager, so a ZIP effectively belongs to
-- one territory per tenant. If that assumption ever breaks, extend to
-- {[territoryId]: [zips]} without dropping this column (backfill from
-- the flat array).

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS zip_exclusions jsonb DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.team_members.zip_exclusions IS
  'jsonb array of 5-digit ZIPs this team member is EXCLUDED from being auto-assigned to, even if their territory contains the ZIP. Manual assignment still allowed (with a warning). Global list, not per-territory.';
