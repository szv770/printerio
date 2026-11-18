-- Printio: the library's shared page cache, the server job queue, and the list of print servers allowed to fill the cache
-- (docs/PHASE-C-PLAN.md, step C1b). Additive only and re-runnable: three new tables, nothing existing is touched.
--
--   library_pages    parsed library pages (Likkutei Sichos volumes, lists, single entries), the same for every school.
--                    Signed-in members read; only the service role writes (the website's "complete" endpoint, after it
--                    validated what a library-fetcher print server sent).
--   server_jobs      "please fetch this page" requests. Members of the requesting school may read them (progress);
--                    only the service role writes. One ACTIVE job per dedupe_key.
--   library_fetchers the print servers that may fill the shared cache. A SEPARATE table (not a flag on `agents`) on
--                    purpose: school admins can update their own `agents` rows, so a flag there could be set by any school
--                    admin and would let their server write the cache every school reads. Nobody signed in can touch it.
-- Nothing is granted to anon. The default privileges (0031) hand new tables to signed-in members, so the grants below take
-- back what each table must not give.

-- 1. library_pages ---------------------------------------------------------------------------------------------------------
create table if not exists public.library_pages (
  -- Built by the server from a fixed set of shapes only, e.g. likkutei:12, list:maamorim:5710, entry:/maamorim/123.
  key text primary key check (char_length(key) between 1 and 200),
  kind text not null check (char_length(kind) between 1 and 40),
  payload jsonb not null check (jsonb_typeof(payload) in ('object', 'array') and octet_length(payload::text) <= 1500000),
  source_url text check (source_url is null or char_length(source_url) <= 500),
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  fetched_by uuid references public.agents (id) on delete set null
);

alter table public.library_pages enable row level security;

drop policy if exists "members can read the library pages" on public.library_pages;
create policy "members can read the library pages"
  on public.library_pages for select
  to authenticated
  using (true);

revoke insert, update, delete, truncate, references, trigger on public.library_pages from authenticated;
revoke all on public.library_pages from anon;
grant select on public.library_pages to authenticated;
grant select, insert, update, delete on public.library_pages to service_role;

-- 2. server_jobs -----------------------------------------------------------------------------------------------------------
create table if not exists public.server_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('library_fetch')),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  requested_by uuid references public.profiles (id) on delete set null,
  -- A small structured object (never a URL): e.g. {"kind":"likkutei","volume":12}. The print server builds the address itself.
  params jsonb not null check (jsonb_typeof(params) = 'object' and octet_length(params::text) <= 2000),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  status text not null default 'queued' check (status in ('queued', 'claimed', 'done', 'failed')),
  claimed_by uuid references public.agents (id) on delete set null,
  lease_until timestamptz,
  result_key text check (result_key is null or char_length(result_key) <= 200),
  error text check (error is null or char_length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one active (queued or claimed) job per key: twenty people opening the same page share one fetch.
create unique index if not exists server_jobs_one_active_per_key
  on public.server_jobs (dedupe_key)
  where status in ('queued', 'claimed');

-- For the claim query (oldest queued first) and the expired-lease sweep.
create index if not exists server_jobs_claim_idx on public.server_jobs (status, created_at);
create index if not exists server_jobs_org_idx on public.server_jobs (organization_id);

drop trigger if exists server_jobs_set_updated_at on public.server_jobs;
create trigger server_jobs_set_updated_at
  before update on public.server_jobs
  for each row execute function private.set_updated_at();

alter table public.server_jobs enable row level security;

drop policy if exists "members can read their school's server jobs" on public.server_jobs;
create policy "members can read their school's server jobs"
  on public.server_jobs for select
  to authenticated
  using (organization_id in (select private.user_org_ids()));

-- Read for the requesting school's members; every write goes through the service role.
revoke insert, update, delete, truncate, references, trigger on public.server_jobs from authenticated;
revoke all on public.server_jobs from anon;
grant select on public.server_jobs to authenticated;
grant select, insert, update, delete on public.server_jobs to service_role;

-- 3. library_fetchers ------------------------------------------------------------------------------------------------------
-- The owner registers a print server by hand (SQL editor, service role): insert into library_fetchers (agent_id) values ('<agent uuid>');
create table if not exists public.library_fetchers (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  added_at timestamptz not null default now()
);

-- RLS on and NO policy: even if a grant slipped back in, a signed-in user would see and change nothing.
alter table public.library_fetchers enable row level security;

revoke all on public.library_fetchers from authenticated;
revoke all on public.library_fetchers from anon;
grant select, insert, update, delete on public.library_fetchers to service_role;
