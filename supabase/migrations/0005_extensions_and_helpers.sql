-- PrintOS: extensions, private schema, RLS helper functions, and the small set
-- of generic triggers (updated_at bookkeeping, auth.users -> profiles mirroring)
-- that reference tables created in migrations 0001-0004.
-- See docs/architecture.md sec 3 for why these helpers exist (join-free RLS policies).

create extension if not exists pgcrypto;

-- Non-API-exposed schema for internal helper functions (security definer, etc.).
-- Never exposed via PostgREST (only `public` and any explicitly configured schemas are).
create schema if not exists private;

-- Cleanup: drop the placeholder created while sequencing this migration set.
drop function if exists private_handle_new_auth_user_placeholder();

-- Returns the calling user's active organization memberships.
-- SECURITY DEFINER + empty search_path per Supabase's documented RLS performance
-- guidance: policies use `organization_id in (select private.user_org_ids())`
-- instead of joining organization_members inside every policy body.
create or replace function private.user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select organization_id
  from public.organization_members
  where user_id = auth.uid()
    and status = 'active'
$$;

comment on function private.user_org_ids() is
  'Active organization ids for the calling user. Used by RLS policies to avoid '
  'per-row joins against organization_members (see docs/architecture.md sec 3.1).';

-- Returns true if the calling user is an active org_admin of the given organization.
create or replace function private.is_org_admin(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.user_id = auth.uid()
      and m.organization_id = target_org
      and m.status = 'active'
      and m.role = 'org_admin'
  )
$$;

-- Returns true if the calling user is an active approver or org_admin of the org
-- (approvers and org_admins can both act on the approval queue).
create or replace function private.is_org_approver(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.user_id = auth.uid()
      and m.organization_id = target_org
      and m.status = 'active'
      and m.role in ('org_admin', 'approver')
  )
$$;

-- Returns the organization ids where the calling user is an active org_admin.
-- Used by profile-visibility and cross-table admin-management policies so they
-- don't need a per-target-org parameter (unlike is_org_admin(target_org)).
create or replace function private.org_admin_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select organization_id
  from public.organization_members
  where user_id = auth.uid()
    and status = 'active'
    and role = 'org_admin'
$$;

-- Returns true if the calling user is a platform super_admin (profiles.platform_role).
-- Note: being a super_admin grants NO implicit org-scoped access by itself (see
-- docs/architecture.md sec 2.1) - it is only used for platform-level operations like
-- creating organizations.
create or replace function private.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'super_admin'
  )
$$;

-- Generic updated_at trigger.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organization_settings_set_updated_at
  before update on organization_settings
  for each row execute function private.set_updated_at();

create trigger print_jobs_set_updated_at
  before update on print_jobs
  for each row execute function private.set_updated_at();

create trigger monthly_usage_set_updated_at
  before update on monthly_usage
  for each row execute function private.set_updated_at();

-- Auto-create a profile row whenever a new auth.users row is created (e.g. on
-- first Google OAuth sign-in). SECURITY DEFINER so it can insert into
-- public.profiles regardless of the caller's RLS grants.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();
