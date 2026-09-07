-- print_jobs_validate_transition (BEFORE UPDATE trigger) calls
-- private.print_job_transition_allowed(), but the trigger function itself was
-- plain SECURITY INVOKER - so it ran as whatever role performed the UPDATE.
-- An ordinary `authenticated` role has no USAGE grant on schema `private` at
-- all (by design - see 0019_close_anon_execute_gap...), so ANY status change
-- to print_jobs by a real user (approving, rejecting - anything except a
-- service-role write) failed outright with "permission denied for schema
-- private", the instant it was first exercised for real. Fixed the same way
-- private.is_org_admin/is_org_approver already are: SECURITY DEFINER with
-- set search_path = '' so it runs with the elevated privilege it actually
-- needs, while the print_jobs RLS UPDATE policy (evaluated independently,
-- before the trigger ever fires) still fully governs who may write the row
-- at all.
create or replace function private.validate_print_job_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     and not private.print_job_transition_allowed(old.status, new.status) then
    raise exception 'illegal print_jobs status transition: % -> %', old.status, new.status;
  end if;
  return new;
end;
$$;

comment on function private.validate_print_job_transition() is
  'SECURITY DEFINER (set search_path = '''') so an ordinary authenticated '
  'role can approve/reject/etc a job without needing USAGE on schema '
  'private - the print_jobs RLS UPDATE policy is what actually governs '
  'who may write the row; this only validates the status transition shape.';
