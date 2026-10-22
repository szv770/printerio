-- Printio: member devices for native printing from the OS print dialog (IPP gateway).
-- Contract: docs/superpowers/specs/2026-10-22-gateway-contract.md ("Database").
--
-- A member adds a device (phone, laptop, Chromebook). Each device gets its own secret address
-- (https://u-<token>.<base domain>/ipp/print). Only the SHA-256 of the token is stored (token_hash);
-- the raw token is shown to the member once, at creation. The gateway (service role) resolves a
-- token hash to the member and records events; jobs it creates are normal print_jobs rows.
--
-- Access model:
--   - member: sees / adds / renames / revokes their own devices
--   - org_admin: sees every device of their organization
--   - service_role: everything (the gateway and the /api/gateway routes)
--   - token_hash is NEVER readable by the browser roles: authenticated gets column-level SELECT
--     on every column except token_hash (so `select *` fails for them - list columns explicitly).

-- ============================================================================
-- member_devices
-- ============================================================================
create table if not exists member_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  device_type text not null default 'other'
    check (device_type in ('windows', 'android', 'chromebook', 'iphone', 'mac', 'other')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  last_user_agent text,
  first_job_at timestamptz,
  first_printed_at timestamptz,
  foreign key (user_id, organization_id)
    references organization_members (user_id, organization_id) on delete cascade
);

create index if not exists member_devices_user_idx on member_devices (user_id);
create index if not exists member_devices_org_idx on member_devices (organization_id);

alter table member_devices enable row level security;

drop policy if exists "members see own devices; org admins see their org's devices" on member_devices;
create policy "members see own devices; org admins see their org's devices"
on member_devices for select
to authenticated
using (
  user_id = (select auth.uid())
  or private.is_org_admin(organization_id)
);

drop policy if exists "members add devices for themselves" on member_devices;
create policy "members add devices for themselves"
on member_devices for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and organization_id in (select private.user_org_ids())
);

drop policy if exists "members update own devices" on member_devices;
create policy "members update own devices"
on member_devices for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

-- A revoked device must stay revoked: only a service-role operation may change revoked_at once set
-- (same pattern as 0016's last_authenticated_at guard). Adding a new device is the member's way back.
create or replace function private.prevent_device_unrevoke()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null
     and new.revoked_at is distinct from old.revoked_at
     and coalesce(auth.role(), 'anon') <> 'service_role' then
    raise exception 'a revoked device cannot be re-enabled; add a new device instead';
  end if;
  return new;
end;
$$;

drop trigger if exists member_devices_prevent_unrevoke on member_devices;
create trigger member_devices_prevent_unrevoke
  before update on member_devices
  for each row execute function private.prevent_device_unrevoke();

-- Grants. 0031 set default privileges that would hand authenticated every column, so start from nothing
-- and grant exactly what the browser roles need. anon gets nothing.
revoke all on table public.member_devices from anon;
revoke all on table public.member_devices from authenticated;
grant select, insert, update, delete on public.member_devices to service_role;
grant select (
  id, organization_id, user_id, name, device_type, created_at, revoked_at,
  first_seen_at, last_seen_at, last_user_agent, first_job_at, first_printed_at
) on public.member_devices to authenticated;
grant insert (organization_id, user_id, name, device_type, token_hash) on public.member_devices to authenticated;
grant update (name, revoked_at) on public.member_devices to authenticated;
-- No DELETE for authenticated: revoking (revoked_at) keeps the audit trail.

comment on table member_devices is
  'A member''s device that prints through the IPP gateway. token_hash = lowercase hex SHA-256 of the 39-char '
  'base32 token in the device''s address; never exposed to browser roles (column-level grants).';

-- ============================================================================
-- device_events (small, append-only log written by the gateway / web routes)
-- ============================================================================
create table if not exists device_events (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references member_devices (id) on delete cascade,
  type text not null,
  user_agent text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists device_events_device_created_idx on device_events (device_id, created_at desc);

alter table device_events enable row level security;

drop policy if exists "members see events of own devices; org admins see their org's" on device_events;
create policy "members see events of own devices; org admins see their org's"
on device_events for select
to authenticated
using (
  exists (
    select 1 from member_devices d
    where d.id = device_events.device_id
      and (d.user_id = (select auth.uid()) or private.is_org_admin(d.organization_id))
  )
);
-- No insert/update/delete policy: only service_role (bypasses RLS) writes events.

revoke all on table public.device_events from anon;
revoke all on table public.device_events from authenticated;
grant select, insert, update, delete on public.device_events to service_role;
grant select on public.device_events to authenticated;

-- ============================================================================
-- device_issues ("I'm having trouble")
-- ============================================================================
create table if not exists device_issues (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references member_devices (id) on delete cascade,
  kind text not null check (kind in ('cant_add', 'nothing_prints', 'prints_wrong', 'other')),
  note text not null default '' check (char_length(note) <= 2000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by uuid references profiles (id),
  resolved_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists device_issues_device_idx on device_issues (device_id);
create index if not exists device_issues_open_idx on device_issues (status) where status = 'open';

alter table device_issues enable row level security;

drop policy if exists "members see issues of own devices; org admins see their org's" on device_issues;
create policy "members see issues of own devices; org admins see their org's"
on device_issues for select
to authenticated
using (
  exists (
    select 1 from member_devices d
    where d.id = device_issues.device_id
      and (d.user_id = (select auth.uid()) or private.is_org_admin(d.organization_id))
  )
);

drop policy if exists "members report issues on own devices" on device_issues;
create policy "members report issues on own devices"
on device_issues for insert
to authenticated
with check (
  status = 'open'
  and resolved_by is null
  and exists (
    select 1 from member_devices d
    where d.id = device_issues.device_id and d.user_id = (select auth.uid())
  )
);

drop policy if exists "org admins resolve issues in their org" on device_issues;
create policy "org admins resolve issues in their org"
on device_issues for update
to authenticated
using (
  exists (
    select 1 from member_devices d
    where d.id = device_issues.device_id and private.is_org_admin(d.organization_id)
  )
)
with check (
  exists (
    select 1 from member_devices d
    where d.id = device_issues.device_id and private.is_org_admin(d.organization_id)
  )
);

revoke all on table public.device_issues from anon;
revoke all on table public.device_issues from authenticated;
grant select, insert, update, delete on public.device_issues to service_role;
grant select on public.device_issues to authenticated;
grant insert (device_id, kind, note) on public.device_issues to authenticated;
grant update (status, resolved_by, resolved_note, resolved_at) on public.device_issues to authenticated;

-- ============================================================================
-- print_jobs: where a job came from
-- ============================================================================
alter table print_jobs add column if not exists source text not null default 'web';
alter table print_jobs drop constraint if exists print_jobs_source_check;
alter table print_jobs add constraint print_jobs_source_check check (source in ('web', 'ipp'));
alter table print_jobs add column if not exists device_id uuid references member_devices (id) on delete set null;
alter table print_jobs add column if not exists ipp_user_agent text;

create index if not exists print_jobs_device_idx on print_jobs (device_id) where device_id is not null;

comment on column print_jobs.source is
  'Where the job came from: web (the upload page) or ipp (the OS print dialog via the IPP gateway).';
comment on column print_jobs.device_id is
  'member_devices.id for source = ipp; null for web jobs and after the device row is deleted.';

-- ============================================================================
-- The gateway runs the job pipeline with the SERVICE ROLE, acting for a member.
-- check_rate_limit (0012/0019) is granted to authenticated only; say so for service_role explicitly
-- instead of relying on Supabase's default function privileges. (adjust_monthly_usage is SECURITY
-- INVOKER with the default PUBLIC execute, so service_role can already call it; RLS is bypassed, and
-- the web code passes the member's user id and organization id explicitly.)
-- ============================================================================
grant execute on function check_rate_limit(text, int, int) to service_role;
