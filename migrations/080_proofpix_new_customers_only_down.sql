-- 080 — rollback users.proofpix_new_customers_only

ALTER TABLE public.users
  DROP COLUMN IF EXISTS proofpix_new_customers_only;
