-- Printio: claim_invitation_use() - atomically increment
-- organization_invitations.uses_count, only if it hasn't hit max_uses yet.
--
-- Fixes a real race in apps/web/lib/auth/invitations.ts's redeemInvitation():
-- it used to read invitation.uses_count, check it against max_uses in
-- application code, then write uses_count + 1 back as a separate,
-- client-computed literal value. Two concurrent redemptions of the same
-- code both read the same uses_count, both pass the check, and both
-- succeed - an enrollment code capped at max_uses: N could admit N+k people
-- under concurrent redemption (this app's actual use case: a class of
-- students all redeeming the same open enrollment code around the same
-- moment). Rephrasing the WHERE clause on a client-side .update() call
-- cannot fix this on its own, because the SET value itself would still be a
-- stale client-computed literal (uses_count + 1 computed in JS from an
-- earlier read) rather than a true SQL-level increment
-- (`uses_count = uses_count + 1`) - PostgREST's .update() only ever sends
-- literal values, never a SQL expression. The increment has to happen
-- inside a single SQL statement, which is what this function is for -
-- mirrors adjust_monthly_usage's identical atomic-conditional-UPDATE shape
-- (0010_quota_functions.sql) for the identical reason: Postgres's per-row
-- locking serializes concurrent UPDATEs to the same row under READ
-- COMMITTED, so each waiting transaction's WHERE clause is evaluated
-- against the previous transaction's already-committed uses_count, not a
-- value read before either transaction started.
--
-- Returns true if this call claimed a use (the row was updated), false if
-- the invitation is already exhausted (max_uses reached). Only ever called
-- from apps/web/lib/auth/invitations.ts's redeemInvitation(), itself always
-- running as service-role (the redeeming user has no organization
-- membership yet, so their own RLS session couldn't touch this table) -
-- SECURITY INVOKER is fine here (same choice adjust_monthly_usage makes),
-- since the only real caller already has full access.
create or replace function claim_invitation_use(p_invitation_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_rows int;
begin
  update public.organization_invitations
  set uses_count = uses_count + 1
  where id = p_invitation_id
    and (max_uses is null or uses_count < max_uses);
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function claim_invitation_use is
  'Atomically increments organization_invitations.uses_count, only if '
  'max_uses has not been reached yet - the increment happens inside this '
  'single SQL statement (uses_count = uses_count + 1), not as a '
  'client-computed literal, so concurrent redemptions of the same code '
  'cannot both read the same stale count and both succeed. Returns true if '
  'this call claimed a use, false if already exhausted. Called only from '
  'apps/web/lib/auth/invitations.ts''s redeemInvitation(), which always '
  'runs as service-role.';

-- Not exposed to anon/authenticated directly via PostgREST - the one real
-- caller (redeemInvitation) always uses the service-role client, which
-- bypasses grants entirely, so there is no legitimate reason for this to be
-- reachable any other way. (Unlike adjust_monthly_usage, which genuinely
-- needs to stay callable by `authenticated` since print submission invokes
-- it under the user's own session - not the same situation as this
-- function, so its own grant shape is deliberately left as-is elsewhere.)
revoke execute on function claim_invitation_use(uuid) from public;
revoke execute on function claim_invitation_use(uuid) from anon;
revoke execute on function claim_invitation_use(uuid) from authenticated;
