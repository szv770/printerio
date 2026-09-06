-- Printio: generic fixed-window rate limiter, backed by Postgres.
--
-- Why DB-backed and not in-memory: apps/web runs on Vercel, where a single
-- serverless function is not one long-lived process - concurrent requests to
-- the same route commonly land on different (or freshly cold-started)
-- instances, so a module-scope counter/map has no cross-instance visibility
-- and resets on every cold start. It would not actually limit anything under
-- real traffic. A shared Postgres row is centralized and correct regardless
-- of which instance handles the request. See the infra/ops scalability
-- review (2026) for the full analysis; Upstash/Redis would shave latency off
-- the hot agent-polling paths if that's ever needed, but isn't required to
-- be correct, and adds an external service this repo doesn't otherwise need.
--
-- Used for: print job submission (per user - app/(dashboard)/print/actions.ts)
-- and agent enrollment (per IP - app/api/agents/register/route.ts, to slow
-- down brute-forcing enrollment codes, a real gap the same review flagged).

-- Never exposed via PostgREST directly (private schema, per
-- 0005_extensions_and_helpers.sql's convention) - only reachable through the
-- SECURITY DEFINER wrapper function below.
create table private.rate_limit_buckets (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);

create or replace function check_rate_limit(p_key text, p_max_count int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_count int;
begin
  v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into private.rate_limit_buckets (key, window_start, count)
  values (p_key, v_window_start, 1)
  on conflict (key, window_start) do update set count = private.rate_limit_buckets.count + 1
  returning count into v_count;

  -- Opportunistic cleanup of this key's own expired windows - cheap (a
  -- handful of rows at most, indexed by the primary key) and means no
  -- separate cron job is needed to keep this table small.
  delete from private.rate_limit_buckets
  where key = p_key and window_start < v_window_start;

  return v_count <= p_max_count;
end;
$$;

comment on function check_rate_limit is
  'Fixed-window rate limiter, DB-backed so it stays correct across Vercel''s '
  'multi-instance serverless model (an in-memory counter is not). Returns '
  'true if this call is allowed (count is now <= p_max_count within the '
  'current p_window_seconds-wide window), false if the caller should be '
  'rejected with a 429. p_key should already be fully scoped by the caller '
  '(e.g. "print_submit:<user_id>", "agent_register:<ip>") - this function '
  'does no authorization of its own, it only counts.';

-- Callable by authenticated users (print submission checks a key scoped to
-- their own user id) and implicitly by service-role (bypasses grants) for
-- the agent register route, which has no authenticated session yet. Not
-- granted to anon - there is no unauthenticated caller of this function.
grant execute on function check_rate_limit(text, int, int) to authenticated;
