-- An org_admin can send a one-page test print to any printer_profile in their
-- organization ("Send test print" on app/admin/printers and on the per-Agent
-- detail page). That test job deliberately goes down the SAME pipeline a real
-- submission does - real PDF preflight, a real object in the private
-- print-jobs bucket, a real print_jobs row the Agent claims, downloads and
-- prints - because a test that skipped any of those would not prove the queue
-- works. What it skips is only the parts that belong to a *person's* job:
-- policy evaluation, the approval queue, and quota.
--
-- This column is what keeps that honest everywhere else: a test print is a
-- real print job, but it is not real *user* print activity, so every place
-- that aggregates user activity (admin Reports, the platform overview, a
-- member's own activity card, "jobs today") filters it out, and neither the
-- Agent status route nor the cron sweep may consume or release quota for one
-- (it never reserved any - releasing would silently eat some *other* pending
-- job's reservation, since adjust_monthly_usage subtracts from the shared
-- monthly_usage row).
--
-- Additive and defaulted false, so every existing row is - correctly - a real
-- job. No RLS change is needed or wanted: print_jobs' existing policies are
-- keyed on organization_id/created_by, which already cover this column, and a
-- test print is created by the admin as themselves (created_by = auth.uid()),
-- not by service-role.
--
-- No index: every query that filters on this also filters organization_id
-- (indexed) and usually a created_at window, and test prints are a rounding
-- error in row count - a partial index here would be dead weight.
alter table print_jobs add column is_test_print boolean not null default false;

comment on column print_jobs.is_test_print is
  'True for an admin-issued test print (app/admin/printers'' "Send test '
  'print"), which exercises the full real pipeline - preflight, storage '
  'upload, agent claim/download/print - against a generated one-page PDF, '
  'but deliberately skips policy evaluation, approval and quota because it '
  'is not a person''s job. Excluded from every user-activity aggregation '
  '(lib/reports.ts and its page, lib/platform/overview.ts, admin/users/'
  '[userId], admin dashboard "jobs today") and from quota consume/release in '
  'app/api/agents/jobs/[jobId]/status and app/api/cron/sweep - a test print '
  'reserved nothing, so releasing for one would decrement another job''s '
  'live reservation.';
