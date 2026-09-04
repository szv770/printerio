-- PrintOS: fixes for Supabase database-linter findings surfaced by get_advisors
-- after the initial schema/RLS migrations landed (see docs/architecture.md sec 3).
-- 1. Pin search_path on the 4 functions that were missing it (security lint).
-- 2. Split 4 "org_admins manage X" FOR ALL policies into insert/update/delete
--    only, so they stop overlapping with the existing members-can-view SELECT
--    policy on the same table (performance lint: multiple_permissive_policies).
-- 3. Add covering indexes for foreign keys the linter flagged as unindexed.
--
-- Not addressed: `public.rls_auto_enable()` (SECURITY DEFINER, callable by
-- anon/authenticated) is a pre-existing Supabase-platform-managed event trigger
-- function (owner: postgres) that auto-enables RLS on newly created tables as a
-- safety net - it was not created by any PrintOS migration and is left alone.

-- ============================================================================
-- 1. search_path fixes
-- ============================================================================
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.prevent_platform_role_escalation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.platform_role is distinct from old.platform_role
     and coalesce(auth.role(), 'anon') <> 'service_role' then
    raise exception 'platform_role can only be changed by a service-role operation';
  end if;
  return new;
end;
$$;

create or replace function private.print_job_transition_allowed(from_status text, to_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case from_status
    when 'draft' then to_status in ('pending_approval', 'approved', 'denied', 'cancelled')
    when 'pending_approval' then to_status in ('approved', 'rejected', 'expired', 'cancelled')
    when 'approved' then to_status in ('claimed', 'expired', 'cancelled')
    when 'claimed' then to_status in ('downloading', 'approved', 'cancelled', 'failed')
    when 'downloading' then to_status in ('downloaded', 'failed', 'cancelled')
    when 'downloaded' then to_status in ('printing', 'failed', 'cancelled')
    when 'printing' then to_status in ('submitted_to_spooler', 'failed')
    when 'submitted_to_spooler' then to_status in ('completed', 'failed')
    when 'failed' then to_status in ('claimed', 'cancelled')
    else false
  end
$$;

create or replace function private.validate_print_job_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     and not private.print_job_transition_allowed(old.status, new.status) then
    raise exception 'illegal print_jobs status transition: % -> %', old.status, new.status;
  end if;
  return new;
end;
$$;

-- ============================================================================
-- 2. Split FOR ALL policies that overlapped an existing SELECT policy
-- ============================================================================
drop policy "org_admins can manage their organization's settings" on organization_settings;
create policy "org_admins can insert their organization's settings"
  on organization_settings for insert to authenticated
  with check (private.is_org_admin(organization_id));
create policy "org_admins can update their organization's settings"
  on organization_settings for update to authenticated
  using (private.is_org_admin(organization_id)) with check (private.is_org_admin(organization_id));
create policy "org_admins can delete their organization's settings"
  on organization_settings for delete to authenticated
  using (private.is_org_admin(organization_id));

drop policy "org_admins can manage groups" on groups;
create policy "org_admins can insert groups"
  on groups for insert to authenticated
  with check (private.is_org_admin(organization_id));
create policy "org_admins can update groups"
  on groups for update to authenticated
  using (private.is_org_admin(organization_id)) with check (private.is_org_admin(organization_id));
create policy "org_admins can delete groups"
  on groups for delete to authenticated
  using (private.is_org_admin(organization_id));

drop policy "org_admins can manage group memberships" on group_members;
create policy "org_admins can insert group memberships"
  on group_members for insert to authenticated
  with check (exists (select 1 from groups g where g.id = group_members.group_id and private.is_org_admin(g.organization_id)));
create policy "org_admins can update group memberships"
  on group_members for update to authenticated
  using (exists (select 1 from groups g where g.id = group_members.group_id and private.is_org_admin(g.organization_id)))
  with check (exists (select 1 from groups g where g.id = group_members.group_id and private.is_org_admin(g.organization_id)));
create policy "org_admins can delete group memberships"
  on group_members for delete to authenticated
  using (exists (select 1 from groups g where g.id = group_members.group_id and private.is_org_admin(g.organization_id)));

drop policy "org_admins can manage printer profiles" on printer_profiles;
create policy "org_admins can insert printer profiles"
  on printer_profiles for insert to authenticated
  with check (exists (select 1 from printers p where p.id = printer_profiles.printer_id and private.is_org_admin(p.organization_id)));
create policy "org_admins can update printer profiles"
  on printer_profiles for update to authenticated
  using (exists (select 1 from printers p where p.id = printer_profiles.printer_id and private.is_org_admin(p.organization_id)))
  with check (exists (select 1 from printers p where p.id = printer_profiles.printer_id and private.is_org_admin(p.organization_id)));
create policy "org_admins can delete printer profiles"
  on printer_profiles for delete to authenticated
  using (exists (select 1 from printers p where p.id = printer_profiles.printer_id and private.is_org_admin(p.organization_id)));

-- ============================================================================
-- 3. Covering indexes for flagged foreign keys
-- ============================================================================
create index approval_actions_approver_idx on approval_actions (approver_id);
create index audit_logs_actor_idx on audit_logs (actor_id);
create index monthly_usage_user_idx on monthly_usage (user_id);
create index organization_invitations_created_by_idx on organization_invitations (created_by);
create index print_jobs_approved_by_idx on print_jobs (approved_by);
create index print_jobs_printer_idx on print_jobs (printer_id);
create index print_jobs_printer_profile_idx on print_jobs (printer_profile_id);
create index remote_commands_issued_by_idx on remote_commands (issued_by);
create index remote_commands_org_idx on remote_commands (organization_id);
create index remote_commands_printer_idx on remote_commands (printer_id);
