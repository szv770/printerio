-- PrintOS: `files_purged_at` marks a print_jobs row whose Storage files have
-- already been removed by the retention sweep
-- (apps/web/app/api/cron/sweep/route.ts), so a job past its retention
-- window whose files are already gone stops being re-selected (and
-- storage.remove() re-called) on every subsequent sweep tick forever. The
-- route's own inline comment already named this exact gap before this
-- migration existed - see docs/architecture.md sec 16. The job row itself
-- is still never deleted (job_number/audit history survives, per the
-- route's existing retention comment); only this marker is new.
alter table print_jobs add column files_purged_at timestamptz;

comment on column print_jobs.files_purged_at is
  'Set once the retention sweep (app/api/cron/sweep/route.ts) has removed '
  'this job''s Storage objects (original_file_path/derived_file_path). Null '
  'means either the files still exist or the job is not yet past its '
  'retention window. Filtered out (`is null`) by the sweep''s selection '
  'query so an already-purged job is never re-selected/re-processed on '
  'every future tick - see docs/architecture.md sec 16.';
