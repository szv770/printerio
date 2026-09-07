-- Printio: close two findings from a correctness/security audit of this
-- session's own work.
--
-- 1. check_rate_limit / email_domain_allowed / email_domain_allowed_for_magic_link
--    were each `grant execute ... to authenticated`, but Postgres grants
--    EXECUTE to PUBLIC by default when a function is created, and none of
--    these migrations ever revoked it. check_rate_limit's own comment
--    explicitly (and, until now, incorrectly) claimed "Not granted to anon -
--    there is no unauthenticated caller of this function" - false at the DB
--    layer. Since check_rate_limit "does no authorization of its own, it
--    only counts" and is SECURITY DEFINER, any anonymous caller could hit
--    PostgREST's /rpc/check_rate_limit directly with an arbitrary p_key
--    (e.g. "print_submit:<victim-user-uuid>", matching exactly the key
--    apps/web/app/(dashboard)/print/actions.ts builds) and pre-inflate that
--    shared bucket row past the real caller's limit - a live, unauthenticated
--    DoS primitive against a specific user's ability to submit print jobs.
--    email_domain_allowed()/email_domain_allowed_for_magic_link() have the
--    same gap; lower risk (return only a boolean, and read auth.uid(), which
--    is null for anon - but revoking anon access is still the honest,
--    defense-in-depth fix that matches what their own comments already
--    claimed was true).
--
-- 2. private.prevent_last_authenticated_at_tampering (0016) omitted the
--    `set search_path = ''` hardening its near-identical sibling trigger
--    (private.prevent_platform_role_escalation, hardened in
--    0009_lint_fixes.sql) already has. supabase_advisors flagged this live
--    (function_search_path_mutable, WARN). Low exploitability today (the
--    trigger body only touches new/old/local variables, no unqualified
--    object references) but it's a real regression against this repo's own
--    established convention, closed here.

revoke execute on function check_rate_limit(text, int, int) from public;
revoke execute on function email_domain_allowed() from public;
revoke execute on function email_domain_allowed_for_magic_link() from public;

-- The `revoke ... from public` statements above are not sufficient on their
-- own: Supabase's own project template applies `alter default privileges in
-- schema public grant execute on functions to anon, authenticated,
-- service_role` at creation time, which grants directly TO the anon role,
-- independent of the PUBLIC pseudo-role - revoking from PUBLIC alone leaves
-- anon's own separate grant untouched (confirmed live via
-- has_function_privilege before/after this exact statement). Revoke from
-- anon explicitly too.
revoke execute on function check_rate_limit(text, int, int) from anon;
revoke execute on function email_domain_allowed() from anon;
revoke execute on function email_domain_allowed_for_magic_link() from anon;

comment on function check_rate_limit is
  'Fixed-window rate limiter, DB-backed so it stays correct across Vercel''s '
  'multi-instance serverless model (an in-memory counter is not). Returns '
  'true if this call is allowed (count is now <= p_max_count within the '
  'current p_window_seconds-wide window), false if the caller should be '
  'rejected with a 429. p_key should already be fully scoped by the caller '
  '(e.g. "print_submit:<user_id>", "agent_register:<ip>") - this function '
  'does no authorization of its own, it only counts. Granted to authenticated '
  'only (explicitly revoked from public/anon - see 0019) since it has no '
  'way to verify a caller-supplied p_key actually belongs to that caller.';

create or replace function private.prevent_last_authenticated_at_tampering()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.last_authenticated_at is distinct from old.last_authenticated_at
     and coalesce(auth.role(), 'anon') <> 'service_role' then
    raise exception 'last_authenticated_at can only be changed by a service-role operation';
  end if;
  return new;
end;
$$;
