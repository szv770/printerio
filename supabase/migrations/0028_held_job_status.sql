-- `held`: a job whose print options could not be confidently resolved (e.g. an IPP job
-- whose options cannot be mapped). The sender or an admin must choose before it proceeds.
-- Mirrors packages/shared/src/job-state.ts: draft -> held; held -> pending_approval |
-- approved | denied | cancelled | expired. See docs/superpowers/specs/2026-10-20-printio-setup-design.md.

-- 1. Status check constraint (inline check from 0003 is auto-named print_jobs_status_check).
alter table print_jobs drop constraint if exists print_jobs_status_check;
alter table print_jobs add constraint print_jobs_status_check check (status in (
  'draft', 'held', 'pending_approval', 'approved', 'denied', 'rejected', 'expired',
  'cancelled', 'claimed', 'downloading', 'downloaded', 'printing',
  'submitted_to_spooler', 'completed', 'failed'
));

-- 2. Transition rules. The trigger function validate_print_job_transition() (0023, SECURITY
-- DEFINER) just calls this function, so only this needs replacing. Keeps 0009's
-- `set search_path = ''`.
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
    when 'failed' then to_status in ('claimed', 'cancelled')
    else false
  end
$$;

-- 3. Columns (nullable, additive).
alter table print_jobs
  add column if not exists held_reason text,
  add column if not exists staple_position text,
  add column if not exists page_range text;

alter table print_jobs drop constraint if exists print_jobs_staple_position_check;
alter table print_jobs add constraint print_jobs_staple_position_check
  check (staple_position is null or staple_position in ('top-left', 'top-right'));
