-- Printio: "Test my connection" results from the add-device flow.
--
-- The browser on the device being set up tries our own site, a short token-free probe address and the person's real
-- print address, and reports yes/no + milliseconds for each. The server (never the browser) validates the report,
-- adds the User-Agent from the request, and writes one row. So the table never holds an address or token, and a
-- member cannot forge a row for someone else's device (the server checks the device is theirs).
-- RLS: members see their own results, org admins see the whole org's. Only service_role writes. Re-runnable.

create table if not exists public.device_connection_tests (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.member_devices (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  control_ok boolean not null,
  control_ms integer not null check (control_ms between 0 and 60000),
  probe_ok boolean not null,
  probe_ms integer not null check (probe_ms between 0 and 60000),
  real_ok boolean not null,
  real_ms integer not null check (real_ms between 0 and 60000),
  verdict text not null check (verdict in ('reachable', 'offline', 'address_blocked', 'domain_blocked', 'mixed')),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default now()
);

create index if not exists device_connection_tests_device_idx on public.device_connection_tests (device_id, created_at desc);
create index if not exists device_connection_tests_org_idx on public.device_connection_tests (organization_id, created_at desc);
create index if not exists device_connection_tests_user_idx on public.device_connection_tests (user_id);

alter table public.device_connection_tests enable row level security;

drop policy if exists "members see own connection tests; org admins see their org's" on public.device_connection_tests;
create policy "members see own connection tests; org admins see their org's"
on public.device_connection_tests for select to authenticated
using (user_id = (select auth.uid()) or private.is_org_admin(organization_id));

revoke all on table public.device_connection_tests from anon;
revoke all on table public.device_connection_tests from authenticated;
grant select, insert, update, delete on public.device_connection_tests to service_role;
grant select on public.device_connection_tests to authenticated;
