-- Printio: prepare jobs (docs/PREPARE-JOBS-DESIGN.md, work package P1).
--
-- The website is moving to a host that cannot do heavy PDF work, so the PDF steps of a print (preflight, sanitize, page range,
-- booklet imposition, stamp, text-fidelity check) run on the organization's own print server. The website records a small
-- "prepare job"; the print server claims it (only its own organization's), downloads the original, prepares it, uploads the
-- result and reports back. Only after that does the website create the normal print_jobs row, so the print job state machine
-- is untouched.
--
-- This reuses public.server_jobs (migration 0055: claim, lease, expiry) instead of a second table:
--   * kind 'prepare_pdf' is allowed next to 'library_fetch'
--   * params may be up to 16000 bytes for prepare jobs (print choices, stamp settings), still 2000 for library jobs
--   * new status 'cancelled' (the sender cancelled while it was waiting or being prepared)
--   * new columns: source_path (the original in the private print-jobs bucket), result (small jsonb: page counts, flags, the
--     prepared file's path, the fidelity verdict), finished_at
--   * a prepare job always has a requester and a source file
--   * prepare jobs are readable only by the person who made them and their organization's admins (they hold print choices and a
--     file path); library jobs stay readable by every member of the school, as before
-- Library jobs are not touched. Re-runnable. Nothing here is applied until the owner applies it.

-- 1. Constraints (named by what they check, so a differently named inline constraint is still found) --------------------------
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.server_jobs'::regclass
      and contype = 'c'
      and (
        pg_get_constraintdef(oid) like '%library_fetch%'
        or pg_get_constraintdef(oid) like '%params%'
        or pg_get_constraintdef(oid) like '%queued%'
      )
  loop
    execute format('alter table public.server_jobs drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.server_jobs
  add constraint server_jobs_kind_check check (kind in ('library_fetch', 'prepare_pdf'));

alter table public.server_jobs
  add constraint server_jobs_params_check check (
    jsonb_typeof(params) = 'object'
    and octet_length(params::text) <= case when kind = 'prepare_pdf' then 16000 else 2000 end
  );

alter table public.server_jobs
  add constraint server_jobs_status_check check (status in ('queued', 'claimed', 'done', 'failed', 'cancelled'));

-- 2. New columns -------------------------------------------------------------------------------------------------------------
alter table public.server_jobs add column if not exists source_path text;
alter table public.server_jobs add column if not exists result jsonb;
alter table public.server_jobs add column if not exists finished_at timestamptz;

alter table public.server_jobs drop constraint if exists server_jobs_source_path_check;
alter table public.server_jobs
  add constraint server_jobs_source_path_check check (source_path is null or char_length(source_path) between 1 and 300);

alter table public.server_jobs drop constraint if exists server_jobs_result_check;
alter table public.server_jobs
  add constraint server_jobs_result_check check (
    result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 64000)
  );

-- A prepare job always says who asked and which file to prepare.
alter table public.server_jobs drop constraint if exists server_jobs_prepare_shape_check;
alter table public.server_jobs
  add constraint server_jobs_prepare_shape_check check (
    kind <> 'prepare_pdf' or (requested_by is not null and source_path is not null)
  );

-- 3. The claim query for one organization's print server (oldest waiting prepare job of that organization) -------------------
create index if not exists server_jobs_prepare_claim_idx
  on public.server_jobs (organization_id, status, created_at)
  where kind = 'prepare_pdf';

-- 4. Who may read what ---------------------------------------------------------------------------------------------------------
drop policy if exists "members can read their school's server jobs" on public.server_jobs;
drop policy if exists "members can read their school's library jobs" on public.server_jobs;
drop policy if exists "requester and admins can read prepare jobs" on public.server_jobs;

create policy "members can read their school's library jobs"
  on public.server_jobs for select
  to authenticated
  using (kind = 'library_fetch' and organization_id in (select private.user_org_ids()));

create policy "requester and admins can read prepare jobs"
  on public.server_jobs for select
  to authenticated
  using (
    kind = 'prepare_pdf'
    and (requested_by = (select auth.uid()) or private.is_org_admin(organization_id))
  );

-- Writes stay with the service role only (unchanged from 0055). Restated so this migration's access decision is reviewable.
revoke insert, update, delete, truncate, references, trigger on public.server_jobs from authenticated;
revoke all on public.server_jobs from anon;
grant select on public.server_jobs to authenticated;
grant select, insert, update, delete on public.server_jobs to service_role;
