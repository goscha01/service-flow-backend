-- Rollback for 077_proofpix_customer_first_job.sql
DROP FUNCTION IF EXISTS public.proofpix_customer_first_job(integer, integer[]);
NOTIFY pgrst, 'reload schema';
