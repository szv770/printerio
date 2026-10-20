-- Per-job booklet binding side. The upload page lets a member choose left or right binding for each
-- booklet; the job stores it so imposition, the Agent (download-url raw.bindingSide) and re-print all
-- use the same side. Null = not a booklet job, or an older job: fall back to the printer profile's
-- booklet_binding_side. Mirrors 0028's style (named check, drop-if-exists so it can be re-run).
alter table print_jobs
  add column if not exists booklet_binding_side text;

alter table print_jobs drop constraint if exists print_jobs_booklet_binding_side_check;
alter table print_jobs add constraint print_jobs_booklet_binding_side_check
  check (booklet_binding_side is null or booklet_binding_side in ('left', 'right'));
