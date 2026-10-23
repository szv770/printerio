-- Printio: least-privilege grants on public tables, sequences and functions
-- (security review F11).
--
-- Why: Supabase's default privileges gave anon AND authenticated ALL privileges
-- (including TRUNCATE, REFERENCES, TRIGGER) on every public table, and 0031 only
-- made the authenticated/service_role grants explicit. Today RLS alone stops
-- misuse (every public table has RLS on, no policy applies to anon), so this is
-- defence in depth: one future table created without RLS, or one overly broad
-- policy, must not be an open door.
--
-- What the app really needs (checked against apps/web: browser/server clients use
-- the `authenticated` role through RLS; everything else uses service_role):
--   anon              nothing at all on tables or sequences.
--   authenticated     SELECT/INSERT/UPDATE/DELETE only where an RLS policy for that command
--                     exists. Never TRUNCATE, REFERENCES, TRIGGER. No sequences.
--   service_role      unchanged (full access; it bypasses RLS by design).
--   functions         anon / authenticated need EXECUTE on no function in `public`: every
--                     rpc() the app makes uses the service-role client.
--
-- Safe to re-run: REVOKE of a privilege that is not held is a no-op. Nothing here
-- adds a privilege. Verify before/after with supabase/verify/grants_audit.sql
-- (zero rows = clean). Apply AFTER the web deploy that contains this change
-- (the new sign-in code no longer calls email_domain_allowed*).

-- 1. anon: nothing on public tables/sequences, now and for future tables.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

-- 2. authenticated: never TRUNCATE / REFERENCES / TRIGGER; no sequences
--    (the only sequence is print_jobs_number_seq, used by service-role inserts).
revoke truncate, references, trigger on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;
alter default privileges in schema public revoke all on sequences from authenticated;
alter default privileges in schema public revoke all on functions from authenticated;

-- 3. authenticated: drop write privileges that no RLS policy can ever use
--    (policy list in 0006/0033/0034; re-derived by the grants test).
revoke update, delete on public.approval_actions from authenticated;   -- policies: select, insert
revoke update, delete on public.audit_logs from authenticated;         -- immutable trail: select, insert
revoke update, delete on public.print_job_events from authenticated;   -- policies: select, insert
revoke insert, delete on public.organizations from authenticated;      -- policies: select, update
revoke insert, delete on public.profiles from authenticated;           -- rows come from the auth trigger
revoke delete on public.remote_commands from authenticated;            -- policies: select, insert, update

-- 4. Functions: nothing in `public` is for browser roles.
--    email_domain_allowed*() were the old sign-in gate (superseded by join_mode, 0039).
revoke execute on function public.email_domain_allowed() from public, anon, authenticated;
revoke execute on function public.email_domain_allowed_for_magic_link() from public, anon, authenticated;
revoke execute on all functions in schema public from anon;
