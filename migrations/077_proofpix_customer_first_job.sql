-- ProofPix integration — expose per-job "is this the customer's
-- first real (non-cancelled) job" signal to the /jobs response.
--
-- Used by the ProofPix mobile app's "Automatically create ProofPix
-- projects for → New customers only" setting: when the user picks
-- that mode, the mobile client only auto-creates a project when
-- is_first_job_for_customer === true, so the app doesn't spawn a
-- project for every recurring visit.
--
-- Set-based (no N+1). Given a page of jobs, the mobile client's
-- adapter batches the customer_ids on the page and this RPC returns
-- one row per customer with the earliest non-cancelled
-- (scheduled_date, id) pair. The route handler then compares each
-- page row against that pair to derive is_first_job_for_customer.
--
-- Ordering:
--   (scheduled_date, id) ascending. scheduled_date is `text NOT NULL`
--   in the schema (mixed 'YYYY-MM-DD' and 'YYYY-MM-DD HH:MM:SS' —
--   lexicographic sort is chronological either way because both share
--   the same 'YYYY-MM-DD' prefix). id is the tie-breaker for jobs
--   scheduled on the same date. Matches the ordering used elsewhere
--   in proofpix-service.js (cursor encoding, page ordering).
--
-- Cancelled jobs are excluded so a cancelled first booking never
-- consumes the customer's "first job" status; the next real
-- (non-cancelled) job becomes first.
--
-- Tenant-scoped on p_user_id — safe to expose to any authenticated SF
-- role because a caller cannot use it to peek at another workspace's
-- first-job flags. The route handler already validates the JWT
-- before calling; this is defense-in-depth to match 067_proofpix_job_photo_counts.
--
-- Rollback: 077_proofpix_customer_first_job_down.sql

CREATE OR REPLACE FUNCTION public.proofpix_customer_first_job(
  p_user_id      integer,
  p_customer_ids integer[]
)
RETURNS TABLE(customer_id integer, scheduled_date text, job_id integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (j.customer_id)
    j.customer_id,
    j.scheduled_date,
    j.id
  FROM public.jobs j
  WHERE j.user_id     = p_user_id
    AND j.customer_id = ANY(p_customer_ids)
    AND j.status     <> 'cancelled'
  ORDER BY j.customer_id, j.scheduled_date, j.id;
$$;

COMMENT ON FUNCTION public.proofpix_customer_first_job(integer, integer[]) IS
  'Per-customer earliest non-cancelled (scheduled_date, id). Used by GET /api/integrations/proofpix/jobs to derive is_first_job_for_customer without N+1 queries.';

-- Match 074_revoke_public_rpc.sql lockdown: only service_role (backend)
-- can call this RPC. ProofPix mobile hits the route handler, which uses
-- service_role internally.
REVOKE EXECUTE ON FUNCTION public.proofpix_customer_first_job(integer, integer[])
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
