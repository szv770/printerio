-- Printio: read-only grants / RLS audit (security review F11, migration 0040).
-- Run in the Supabase SQL editor BEFORE and AFTER applying 0040. It only reads
-- the catalog (no writes). ZERO ROWS = clean; every row is a finding.
-- The same file is executed by apps/web/lib/db-test/grants.db.test.ts against
-- a replay of all migrations, so it is tested, not just written.

with tbl as (
  select c.oid, c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
),
seq as (
  select c.oid, c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'S'
),
fn as (
  select p.oid, n.nspname, p.proname, p.proconfig,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prokind = 'f'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
)
select 'anon_has_table_privilege' as finding, t.relname::text as object, p as detail
from tbl t, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
where has_table_privilege('anon', t.oid, p)
union all
select 'anon_has_sequence_privilege', s.relname::text, p
from seq s, unnest(array['USAGE','SELECT','UPDATE']) p
where has_sequence_privilege('anon', s.oid, p)
union all
select 'authenticated_has_sequence_privilege', s.relname::text, p
from seq s, unnest(array['USAGE','SELECT','UPDATE']) p
where has_sequence_privilege('authenticated', s.oid, p)
union all
select 'authenticated_has_dangerous_table_privilege', t.relname::text, p
from tbl t, unnest(array['TRUNCATE','REFERENCES','TRIGGER']) p
where has_table_privilege('authenticated', t.oid, p)
union all
-- A write privilege with no RLS policy for that command can never be used by
-- authenticated: it is dead weight that only becomes dangerous if someone later
-- adds a permissive policy by mistake.
select 'authenticated_write_grant_without_policy', t.relname::text, p.priv
from tbl t,
     (values ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
where has_table_privilege('authenticated', t.oid, p.priv)
  and not exists (
    select 1 from pg_policies pp
    where pp.schemaname = 'public' and pp.tablename = t.relname
      and pp.cmd in (p.priv, 'ALL')
      and (pp.roles && array['authenticated', 'public']::name[])
  )
union all
select 'rls_disabled_on_public_table', t.relname::text, ''
from tbl t join pg_class c on c.oid = t.oid
where not c.relrowsecurity
union all
-- Every RPC the app calls goes through the service-role client, so signed-in
-- users and anon need EXECUTE on no function in public.
select 'public_function_executable_by_' || r, f.sig, ''
from fn f, unnest(array['anon','authenticated']) r
where f.nspname = 'public' and has_function_privilege(r, f.oid, 'EXECUTE')
union all
select 'function_without_fixed_search_path', f.nspname || '.' || f.sig, ''
from fn f
where f.proconfig is null or not exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%')
order by 1, 2, 3;
