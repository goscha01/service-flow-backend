DROP INDEX IF EXISTS public.idx_opportunities_budget_voided_partial;
ALTER TABLE public.opportunities DROP COLUMN IF EXISTS budget_voided_at;

DROP INDEX IF EXISTS public.idx_marketing_spend_user_source;
DROP INDEX IF EXISTS public.idx_marketing_spend_user_period;
DROP INDEX IF EXISTS public.uniq_marketing_spend_with_account;
DROP INDEX IF EXISTS public.uniq_marketing_spend_no_account;
DROP TABLE IF EXISTS public.marketing_spend;
