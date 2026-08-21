-- 079 — rollback users.proofpix_show_recurring_jobs

ALTER TABLE public.users
  DROP COLUMN IF EXISTS proofpix_show_recurring_jobs;
