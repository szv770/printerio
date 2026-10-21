-- Printio: make Data API table grants explicit ahead of Supabase's
-- October 30, 2026 change (new tables in `public` no longer receive
-- automatic grants for the Data API / PostgREST roles).
-- Ref: https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically
--
-- Nothing breaks on the deployed database on Oct 30: existing tables keep
-- their current grants. This migration exists so that:
--   (a) fresh projects, preview branches, and `supabase db reset` runs that
--       replay these migrations after Oct 30 keep working - today every
--       public table here relies on the old implicit defaults, and a reset
--       would leave the whole app with "42501 permission denied for table";
--   (b) tables created by future migrations stay reachable via the Data API.
--
-- Shape (least privilege that matches actual usage):
--   - authenticated + service_role get select/insert/update/delete.
--     Every public table is queried through one or both of those roles from
--     apps/web (browser/server anon-key client and service-role client).
--   - anon gets NO table grants. No unauthenticated code path reads tables;
--     anon only needs function EXECUTE (already granted in 0012/0013/0014/0019).
--   - Row-level security (0006_rls_policies.sql) remains the authorization
--     layer for which rows each role can see; these grants only decide
--     whether PostgREST can reach a table at all.

-- 1. Explicit grants for every table that exists today. Idempotent and a
--    no-op on the current deployment, where these grants already exist via
--    the old defaults.
grant select, insert, update, delete
  on all tables in schema public
  to authenticated, service_role;

-- 2. Default privileges so any table created by a future migration gets the
--    same grants automatically. Default privileges attach to the role that
--    runs migrations, which is the role that creates these tables.
alter default privileges in schema public
  grant select, insert, update, delete on tables
  to authenticated, service_role;

-- If a future table should not be reachable by signed-in users at all
-- (service-role-only), that migration should revoke accordingly:
--   revoke all on table public.<table> from authenticated;
