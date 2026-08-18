-- 078 rollback — drop zip_exclusions column.
-- Safe: no FKs, no downstream views, defaults to []; migration is idempotent.

ALTER TABLE public.team_members
  DROP COLUMN IF EXISTS zip_exclusions;
