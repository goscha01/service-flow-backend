-- 079 — users.proofpix_show_recurring_jobs
--
-- Per-workspace toggle for the ProofPix integration. Controls whether
-- recurring cleaning jobs are exposed to the /api/integrations/proofpix
-- /jobs endpoint (which powers BOTH team-member mobile devices AND the
-- admin's own ProofPix mobile view — "admin sees what team members see"
-- is the deliberate rule so the admin can preview team visibility from
-- their phone).
--
-- Default false: recurring jobs are hidden from ProofPix by default so
-- team members only see one-time / first-clean projects. Admin opts in
-- from Settings → ProofPix.
--
-- Does NOT affect the SF web app — only what flows through the ProofPix
-- integration surface. The admin's SF web /jobs list is unchanged.
--
-- Rollback: 079_proofpix_show_recurring_jobs_down.sql.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS proofpix_show_recurring_jobs boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.proofpix_show_recurring_jobs IS
  'Per-workspace ProofPix visibility toggle. false (default) = the /api/integrations/proofpix/jobs endpoint hides jobs.is_recurring=true (and NULL) from ALL callers (team members + admin''s own device). true = recurring jobs visible. Managed via GET/PATCH /api/integrations/proofpix/settings.';
