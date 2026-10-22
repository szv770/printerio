-- Printio: retry failed prints (owner decision 2026-10-22).
--
-- 1. Transition rule: failed -> approved, the "re-queue" edge used by the owner's "Try again" button and by the
--    optional automatic retry. Mirrors packages/shared/src/job-state.ts. failed -> claimed and failed -> cancelled
--    stay legal. Everything else is exactly as in 0028 (held, etc.), with set search_path = '' kept.
--    THE WEBSITE CODE NEEDS THIS before "Try again" / automatic retry can work: without it the re-queue UPDATE is
--    rejected by the transition trigger ("illegal print_jobs status transition: failed -> approved") and the user
--    sees a plain "could not try again" message. Nothing else depends on it.
--
-- 2. organization_settings.auto_retry_failed_prints (default OFF): when ON, a print that fails is re-queued
--    automatically until print_jobs.max_attempts is reached, then stays failed with its message. The web code reads
--    this column tolerantly (missing column = OFF), so the code may be deployed before or after this migration.
--
-- Deploy order: either order is safe; apply this migration to turn the two features on.

create or replace function private.print_job_transition_allowed(from_status text, to_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case from_status
    when 'draft' then to_status in ('held', 'pending_approval', 'approved', 'denied', 'cancelled')
    when 'held' then to_status in ('pending_approval', 'approved', 'denied', 'cancelled', 'expired')
    when 'pending_approval' then to_status in ('approved', 'rejected', 'expired', 'cancelled')
    when 'approved' then to_status in ('claimed', 'expired', 'cancelled')
    when 'claimed' then to_status in ('downloading', 'approved', 'cancelled', 'failed')
    when 'downloading' then to_status in ('downloaded', 'failed', 'cancelled')
    when 'downloaded' then to_status in ('printing', 'failed', 'cancelled')
    when 'printing' then to_status in ('submitted_to_spooler', 'failed')
    when 'submitted_to_spooler' then to_status in ('completed', 'failed')
    when 'failed' then to_status in ('claimed', 'approved', 'cancelled')
    else false
  end
$$;

alter table organization_settings
  add column if not exists auto_retry_failed_prints boolean not null default false;

comment on column organization_settings.auto_retry_failed_prints is
  'When true, a failed print is re-queued automatically (failed -> approved) until print_jobs.max_attempts is reached; '
  'it then stays failed with its message. Default off: the owner presses Try again instead.';

-- Explicit grants (CLAUDE.md / 0031): admins update the setting under the existing RLS policy; the service role reads it.
grant select, insert, update, delete on public.organization_settings to authenticated, service_role;
