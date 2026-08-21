-- 080 — users.proofpix_new_customers_only
--
-- Second workspace-level visibility toggle for the ProofPix integration
-- (companion to 079's proofpix_show_recurring_jobs). When true, the
-- /api/integrations/proofpix/jobs endpoint drops any row whose
-- is_first_job_for_customer is not exactly true — i.e., ONLY the
-- customer's very first non-cancelled booking passes.
--
-- Design rationale (2026-08-21 conversation with admin @sayapingeorge):
--   • Admin wants a single workspace setting that both they AND their
--     team members' mobile devices honor uniformly. Previously the
--     "new customers only" behavior was device-local AsyncStorage on
--     ProofPix mobile (`@sf_creation_policy_v1`) — different devices
--     could diverge and team members had no equivalent toggle.
--   • This column moves the source of truth to SF workspace. Mobile
--     Cloud Sync toggle now PATCHes /settings instead of writing
--     local state; team members automatically inherit.
--
-- Semantics:
--   false (default) — no first-time filter applied.
--   true            — server drops any job where
--                     is_first_job_for_customer !== true. Null values
--                     (RPC failed) are treated as NOT first-time so
--                     mobile picker doesn't fill with "unknowns".
--
-- Rollback: 080_proofpix_new_customers_only_down.sql.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS proofpix_new_customers_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.proofpix_new_customers_only IS
  'Per-workspace ProofPix visibility toggle (companion to proofpix_show_recurring_jobs). true = /api/integrations/proofpix/jobs response is filtered to rows where is_first_job_for_customer === true. false (default) = no filter. Managed via GET/PATCH /api/integrations/proofpix/settings.';
