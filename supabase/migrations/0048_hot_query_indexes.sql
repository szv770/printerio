-- Printio: indexes for the hot queries (Agent polling, lease recovery, the member's own job list, the org job list)
-- and a prune function for the rate-limit table. Re-runnable. Nothing here changes behaviour; it only changes how
-- fast the same queries run. Plain CREATE INDEX takes a short write lock on print_jobs, which is a small table here.

-- /api/agents/jobs/claimable: approved jobs for this agent's printer profiles, oldest first (created_at, id).
create index if not exists print_jobs_claimable_idx
  on public.print_jobs (printer_profile_id, created_at, id)
  where status = 'approved';

-- Lease recovery (the claimable poll and the daily sweep): jobs an Agent holds (claimed, or any mid-flight state)
-- whose lease has expired. States match MID_FLIGHT_STATUSES in apps/web/lib/lease-recovery.ts plus 'claimed'.
create index if not exists print_jobs_expired_lease_idx
  on public.print_jobs (lease_expires_at)
  where status in ('claimed', 'downloading', 'downloaded', 'printing', 'submitted_to_spooler');

-- "My jobs": a member's own jobs, newest first.
create index if not exists print_jobs_created_by_created_at_idx
  on public.print_jobs (created_by, created_at desc);

-- Organization-wide job lists and reports, newest first.
create index if not exists print_jobs_org_created_at_idx
  on public.print_jobs (organization_id, created_at desc);

-- private.rate_limit_buckets only prunes the calling key's own old windows (0012), so keys that are never used again
-- stay forever. The daily cleanup cron (apps/web/app/api/cron/cleanup/route.ts) calls this through the service role.
-- Returns how many rows it deleted. A window older than a day can no longer affect any limit in use.
create or replace function public.prune_rate_limit_buckets(p_older_than interval default interval '1 day')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from private.rate_limit_buckets where window_start < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.prune_rate_limit_buckets is 'Deletes rate_limit_buckets windows older than p_older_than (default 1 day). Service role only; called by the daily cleanup cron.';

revoke execute on function public.prune_rate_limit_buckets(interval) from public, anon, authenticated;
grant execute on function public.prune_rate_limit_buckets(interval) to service_role;
