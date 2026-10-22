-- Printio: close the member write holes on print_jobs, monthly_usage and the print-jobs bucket.
-- Review findings 1-3, verified against the live DB 2026-10-22.
-- *** DRAFT - NOT APPLIED. Apply only AFTER the matching web code (branch claude/server-side-writes) is deployed. ***
--
-- Before this migration a signed-in member, using the public anon key and their own session from the browser console, could:
--   1. INSERT/UPDATE any column of their own print_jobs rows (self-approve, forge jobs, skip policy and quota);
--   2. INSERT/UPDATE their own monthly_usage row and call adjust_monthly_usage with any amounts (reset their own quota);
--   3. read and overwrite EVERY colleague's PDF in the print-jobs bucket (the policies only checked the org folder).
--
-- After it, every write to those three things happens server-side with the service-role client (which bypasses RLS and
-- keeps its table grants from 0031), after the web app's own authorization checks (apps/web: lib/jobs/create-print-job.ts,
-- app/(dashboard)/print/actions.ts, app/admin/approvals/actions.ts, app/admin/printers/actions.ts,
-- app/admin/storage/actions.ts, app/(dashboard)/jobs/[id]/actions.ts).
--
-- Decisions:
--   - ALL authenticated write policies on print_jobs are dropped, approvers/admins included: approve, reject, "finish this
--     booklet", test prints and the manual storage cleanup all moved to the service role, so nothing needs them.
--   - SELECT policies stay (job pages, lists, realtime status). The admin DELETE policy on monthly_usage stays, and so does
--     the table-level DELETE grant it needs (the "reset usage" capability from 0006); INSERT/UPDATE are revoked.
--   - Storage: authenticated may only SELECT (read / sign) objects of jobs they own or whose organization they approve.
--     No insert/update/delete for any signed-in role. Paths outside org/<org>/jobs/<job>/ (e.g. gateway-intake/) are
--     service-role only.
--   - adjust_monthly_usage stays SECURITY INVOKER; the service role bypasses RLS, so nothing more is needed.
--   - print_job_events / approval_actions member INSERT policies are NOT touched here (review finding 21, a separate fix).
--
-- ROLLBACK: see the commented block at the bottom.

-- ============================================================================
-- print_jobs: no direct writes from signed-in roles
-- ============================================================================
drop policy if exists "members can create jobs in their own organization" on public.print_jobs;
drop policy if exists "owners can update own jobs; approvers/admins update their org's jobs" on public.print_jobs;

revoke insert, update, delete on table public.print_jobs from authenticated;
grant select on table public.print_jobs to authenticated;
grant select, insert, update, delete on table public.print_jobs to service_role;

-- ============================================================================
-- monthly_usage: read-only for members; usage changes only through adjust_monthly_usage run as service role
-- ============================================================================
drop policy if exists "users can reserve/consume their own usage row" on public.monthly_usage;
drop policy if exists "users can update their own usage row; org_admins can adjust" on public.monthly_usage;

revoke insert, update on table public.monthly_usage from authenticated;
grant select, delete on table public.monthly_usage to authenticated; -- delete is still gated by the "org_admins can reset usage" policy
grant select, insert, update, delete on table public.monthly_usage to service_role;

revoke execute on function public.adjust_monthly_usage(uuid, uuid, text, int, int, int, int, text, int, text)
  from public, anon, authenticated;
grant execute on function public.adjust_monthly_usage(uuid, uuid, text, int, int, int, int, text, int, text)
  to service_role;

-- ============================================================================
-- storage.objects (bucket print-jobs): read only your own jobs' files (or your org's, if you approve); no writes
-- ============================================================================
drop policy if exists "org members can read their org's job files" on storage.objects;
drop policy if exists "org members can upload their org's job files" on storage.objects;
drop policy if exists "org members can update their org's job files" on storage.objects;
drop policy if exists "org_admins can delete their org's job files" on storage.objects;

-- Path convention (apps/web/lib/storage.ts): org/<organizationId>/jobs/<jobId>/original.pdf | derived.pdf, so
-- storage.foldername(name) = {org, <organizationId>, jobs, <jobId>}. Segments are compared as TEXT on purpose: a uuid
-- cast on an arbitrary path segment (say gateway-intake/...) could raise an error instead of just not matching.
create policy "members read their own job files; approvers read their org's"
on storage.objects for select
to authenticated
using (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and (storage.foldername(name))[3] = 'jobs'
  and exists (
    select 1
    from public.print_jobs j
    where j.id::text = (storage.foldername(name))[4]
      and j.organization_id::text = (storage.foldername(name))[2]
      and (j.created_by = (select auth.uid()) or private.is_org_approver(j.organization_id))
  )
);

-- ============================================================================
-- ROLLBACK (uncomment and run to restore the previous, looser behavior). Copied from 0006 / 0007 / 0031 / 0010.
-- ============================================================================
-- -- print_jobs
-- create policy "members can create jobs in their own organization"
-- on print_jobs for insert
-- to authenticated
-- with check (
--   created_by = (select auth.uid())
--   and organization_id in (select private.user_org_ids())
-- );
--
-- create policy "owners can update own jobs; approvers/admins update their org's jobs"
-- on print_jobs for update
-- to authenticated
-- using (
--   created_by = (select auth.uid())
--   or private.is_org_approver(organization_id)
-- )
-- with check (
--   created_by = (select auth.uid())
--   or private.is_org_approver(organization_id)
-- );
-- grant select, insert, update, delete on table public.print_jobs to authenticated, service_role;
--
-- -- monthly_usage
-- create policy "users can reserve/consume their own usage row"
-- on monthly_usage for insert
-- to authenticated
-- with check (user_id = (select auth.uid()) or private.is_org_admin(organization_id));
--
-- create policy "users can update their own usage row; org_admins can adjust"
-- on monthly_usage for update
-- to authenticated
-- using (user_id = (select auth.uid()) or private.is_org_admin(organization_id))
-- with check (user_id = (select auth.uid()) or private.is_org_admin(organization_id));
-- grant select, insert, update, delete on table public.monthly_usage to authenticated, service_role;
--
-- grant execute on function public.adjust_monthly_usage(uuid, uuid, text, int, int, int, int, text, int, text)
--   to public, anon, authenticated, service_role;
--
-- -- storage.objects (print-jobs)
-- drop policy if exists "members read their own job files; approvers read their org's" on storage.objects;
--
-- create policy "org members can read their org's job files"
-- on storage.objects for select
-- to authenticated
-- using (
--   bucket_id = 'print-jobs'
--   and (storage.foldername(name))[1] = 'org'
--   and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
-- );
--
-- create policy "org members can upload their org's job files"
-- on storage.objects for insert
-- to authenticated
-- with check (
--   bucket_id = 'print-jobs'
--   and (storage.foldername(name))[1] = 'org'
--   and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
-- );
--
-- create policy "org members can update their org's job files"
-- on storage.objects for update
-- to authenticated
-- using (
--   bucket_id = 'print-jobs'
--   and (storage.foldername(name))[1] = 'org'
--   and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
-- )
-- with check (
--   bucket_id = 'print-jobs'
--   and (storage.foldername(name))[1] = 'org'
--   and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
-- );
--
-- create policy "org_admins can delete their org's job files"
-- on storage.objects for delete
-- to authenticated
-- using (
--   bucket_id = 'print-jobs'
--   and (storage.foldername(name))[1] = 'org'
--   and private.is_org_admin((storage.foldername(name))[2]::uuid)
-- );
