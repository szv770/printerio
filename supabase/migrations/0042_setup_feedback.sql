-- Printio: "Did it come out OK?" loop for newly added devices.
--
--   device_setup_feedback  one answer per device from the member (Yes / Something was wrong + note).
--                          The setup method (windows_manual_wizard, android_bare_host, mac_lpadmin, ...) is NOT
--                          sent by the browser: a trigger copies organization, user and method from the member's
--                          own device row, so answers cannot be spoofed or mis-filed.
--   setup_confirmations    an org admin marks one exact setup method "Confirmed working" for the organization.
--
-- Not a source of truth for printing: nothing in the print path reads these tables.
-- RLS: members see their own answers, org admins see the whole org's; only org admins write confirmations.
-- Grants are explicit (never anon). Re-runnable.

-- p_variant only matters for the Mac, which has two documented routes: 'terminal' (default) or 'ip_tab'.
create or replace function private.setup_key_for(p_device_type text, p_variant text default null)
returns text language sql immutable set search_path = '' as $$
  select case p_device_type
    when 'windows' then 'windows_manual_wizard'
    when 'android' then 'android_bare_host'
    when 'mac' then case when p_variant = 'ip_tab' then 'mac_ip_tab' else 'mac_lpadmin' end
    else 'other_' || coalesce(p_device_type, 'unknown')
  end
$$;

create table if not exists public.device_setup_feedback (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null unique references public.member_devices (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  setup_key text not null,
  outcome text not null check (outcome in ('ok', 'problem')),
  note text not null default '' check (char_length(note) <= 1000),
  -- Which documented route the member used (Mac only: 'terminal' or 'ip_tab'); null = the default route.
  setup_variant text check (setup_variant is null or setup_variant in ('terminal', 'ip_tab')),
  created_at timestamptz not null default now()
);

create index if not exists device_setup_feedback_org_key_idx on public.device_setup_feedback (organization_id, setup_key);
create index if not exists device_setup_feedback_user_idx on public.device_setup_feedback (user_id);

-- Fills organization / user / method from the device. SECURITY DEFINER so it can read the device row whatever the
-- caller's grants are; the insert policy below still requires the device to be the caller's own.
create or replace function private.fill_setup_feedback()
returns trigger language plpgsql security definer set search_path = '' as $$
declare d record;
begin
  select organization_id, user_id, device_type into d from public.member_devices where id = new.device_id;
  if not found then
    raise exception 'device not found';
  end if;
  new.organization_id := d.organization_id;
  new.user_id := d.user_id;
  new.setup_key := private.setup_key_for(d.device_type, new.setup_variant);
  return new;
end $$;

drop trigger if exists device_setup_feedback_fill on public.device_setup_feedback;
create trigger device_setup_feedback_fill
  before insert on public.device_setup_feedback
  for each row execute function private.fill_setup_feedback();

alter table public.device_setup_feedback enable row level security;

drop policy if exists "members see own answers; org admins see their org's" on public.device_setup_feedback;
create policy "members see own answers; org admins see their org's"
on public.device_setup_feedback for select to authenticated
using (user_id = (select auth.uid()) or private.is_org_admin(organization_id));

drop policy if exists "members answer for their own devices" on public.device_setup_feedback;
create policy "members answer for their own devices"
on public.device_setup_feedback for insert to authenticated
with check (
  exists (
    select 1 from public.member_devices d
    where d.id = device_setup_feedback.device_id and d.user_id = (select auth.uid())
  )
);

revoke all on table public.device_setup_feedback from anon;
revoke all on table public.device_setup_feedback from authenticated;
grant select, insert, update, delete on public.device_setup_feedback to service_role;
grant select on public.device_setup_feedback to authenticated;
grant insert (device_id, outcome, note, setup_variant) on public.device_setup_feedback to authenticated;

create table if not exists public.setup_confirmations (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  setup_key text not null check (char_length(setup_key) between 1 and 80),
  confirmed_by uuid not null references public.profiles (id),
  confirmed_at timestamptz not null default now(),
  primary key (organization_id, setup_key)
);

create index if not exists setup_confirmations_confirmed_by_idx on public.setup_confirmations (confirmed_by);

alter table public.setup_confirmations enable row level security;

drop policy if exists "members read their org's confirmations" on public.setup_confirmations;
create policy "members read their org's confirmations"
on public.setup_confirmations for select to authenticated
using (organization_id in (select private.user_org_ids()));

drop policy if exists "org admins confirm setups" on public.setup_confirmations;
create policy "org admins confirm setups"
on public.setup_confirmations for insert to authenticated
with check (private.is_org_admin(organization_id) and confirmed_by = (select auth.uid()));

drop policy if exists "org admins remove confirmations" on public.setup_confirmations;
create policy "org admins remove confirmations"
on public.setup_confirmations for delete to authenticated
using (private.is_org_admin(organization_id));

revoke all on table public.setup_confirmations from anon;
revoke all on table public.setup_confirmations from authenticated;
grant select, insert, update, delete on public.setup_confirmations to service_role;
grant select, delete on public.setup_confirmations to authenticated;
grant insert (organization_id, setup_key, confirmed_by) on public.setup_confirmations to authenticated;
