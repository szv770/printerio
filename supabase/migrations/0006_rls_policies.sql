-- Printio: Row Level Security. Enabled on every multi-tenant table - see
-- docs/architecture.md sec 3. Nothing in apps/web queries these tables through a
-- policy-free path except the small, explicit set of service-role operations
-- documented inline (agent bearer-auth handlers, invitation redemption, org
-- bootstrap) - see apps/web/lib/server/service-role.ts.

-- ============================================================================
-- profiles
-- ============================================================================
alter table profiles enable row level security;

-- Defense in depth: even though the update policy below lets a user update their
-- own profile row, platform_role must never change except via service-role
-- (which bypasses RLS entirely - this trigger only fires for the RLS-governed
-- authenticated/anon paths, i.e. it stops a user from granting themselves
-- super_admin through the ordinary "edit my profile" action).
create or replace function private.prevent_platform_role_escalation()
returns trigger
language plpgsql
as $$
begin
  if new.platform_role is distinct from old.platform_role
     and coalesce(auth.role(), 'anon') <> 'service_role' then
    raise exception 'platform_role can only be changed by a service-role operation';
  end if;
  return new;
end;
$$;

create trigger profiles_prevent_privilege_escalation
  before update on profiles
  for each row execute function private.prevent_platform_role_escalation();

create policy "users can view own profile or org_admins can view their org's members"
on profiles for select
to authenticated
using (
  id = (select auth.uid())
  or exists (
    select 1 from organization_members m
    where m.user_id = profiles.id
      and m.organization_id in (select private.org_admin_org_ids())
  )
);

create policy "users can update own profile"
on profiles for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- No insert/delete policy for authenticated: rows are created by the
-- on_auth_user_created trigger (security definer) and deleted only via
-- auth.users cascade.

-- ============================================================================
-- organizations / organization_settings
-- ============================================================================
alter table organizations enable row level security;
alter table organization_settings enable row level security;

create policy "members can view their organizations"
on organizations for select
to authenticated
using (id in (select private.user_org_ids()));

create policy "org_admins can update their organization"
on organizations for update
to authenticated
using (private.is_org_admin(id))
with check (private.is_org_admin(id));

-- No insert/delete policy for authenticated: organization creation is a
-- privileged, explicit action performed via the service-role bootstrap/
-- super-admin server action - see docs/architecture.md sec 2.2.

create policy "members can view their organization's settings"
on organization_settings for select
to authenticated
using (organization_id in (select private.user_org_ids()));

create policy "org_admins can manage their organization's settings"
on organization_settings for all
to authenticated
using (private.is_org_admin(organization_id))
with check (private.is_org_admin(organization_id));

-- ============================================================================
-- organization_members / organization_invitations / groups / group_members
-- ============================================================================
alter table organization_members enable row level security;
alter table organization_invitations enable row level security;
alter table groups enable row level security;
alter table group_members enable row level security;

create policy "members can view their org's roster"
on organization_members for select
to authenticated
using (organization_id in (select private.user_org_ids()));

create policy "org_admins can manage members"
on organization_members for insert
to authenticated
with check (private.is_org_admin(organization_id));

create policy "org_admins can update members"
on organization_members for update
to authenticated
using (private.is_org_admin(organization_id))
with check (private.is_org_admin(organization_id));

create policy "org_admins can remove members"
on organization_members for delete
to authenticated
using (private.is_org_admin(organization_id));

create policy "org_admins can manage invitations"
on organization_invitations for all
to authenticated
using (private.is_org_admin(organization_id))
with check (private.is_org_admin(organization_id) and created_by = (select auth.uid()));

-- Note: invitation *redemption* (turning a code into an organization_members row)
-- is a service-role server action, not a client-side insert against
-- organization_members - see docs/architecture.md sec 2.2.

create policy "members can view their org's groups"
on groups for select
to authenticated
using (organization_id in (select private.user_org_ids()));

create policy "org_admins can manage groups"
on groups for all
to authenticated
using (private.is_org_admin(organization_id))
with check (private.is_org_admin(organization_id));

create policy "members can view their org's group memberships"
on group_members for select
to authenticated
using (
  exists (
    select 1 from groups g
    where g.id = group_members.group_id
      and g.organization_id in (select private.user_org_ids())
  )
);

create policy "org_admins can manage group memberships"
on group_members for all
to authenticated
using (
  exists (
    select 1 from groups g
    where g.id = group_members.group_id and private.is_org_admin(g.organization_id)
  )
)
with check (
  exists (
    select 1 from groups g
    where g.id = group_members.group_id and private.is_org_admin(g.organization_id)
  )
);

-- ============================================================================
-- agents (dashboard visibility only - the Agent itself authenticates with its
-- own bearer device secret via a service-role route handler, never a Supabase
-- Auth JWT, so these policies never apply to the Agent's own calls)
-- ============================================================================
alter table agents enable row level security;

create policy "org_admins can manage agents"
on agents for all
to authenticated
using (private.is_org_admin(organization_id))
with check (private.is_org_admin(organization_id));

-- ============================================================================
-- printers / printer_profiles
-- ============================================================================
alter table printers enable row level security;
alter table printer_profiles enable row level security;

create policy "members can view their org's printers"
on printers for select
to authenticated
using (organization_id in (select private.user_org_ids()));

create policy "org_admins can manage printers"
on printers for insert
to authenticated
with check (private.is_org_admin(organization_id));

create policy "org_admins can update printers"
on printers for update
to authenticated
using (private.is_org_admin(organization_id))
with check (private.is_org_admin(organization_id));

create policy "org_admins can delete printers"
on printers for delete
to authenticated
using (private.is_org_admin(organization_id));

create policy "members can view their org's printer profiles"
on printer_profiles for select
to authenticated
using (
  exists (
    select 1 from printers p
    where p.id = printer_profiles.printer_id
      and p.organization_id in (select private.user_org_ids())
  )
);

create policy "org_admins can manage printer profiles"
on printer_profiles for all
to authenticated
using (exists (select 1 from printers p where p.id = printer_profiles.printer_id and private.is_org_admin(p.organization_id)))
with check (exists (select 1 from printers p where p.id = printer_profiles.printer_id and private.is_org_admin(p.organization_id)));

-- ============================================================================
-- print_policies / policy_rules / quotas (admin-facing internals; regular
-- members see the *result* of policy evaluation on their own jobs, not the
-- rule definitions themselves)
-- ============================================================================
alter table print_policies enable row level security;
alter table policy_rules enable row level security;
alter table quotas enable row level security;

create policy "org_admins can manage policies"
on print_policies for all
to authenticated
using (private.is_org_admin(organization_id))
with check (private.is_org_admin(organization_id));

create policy "org_admins can manage policy rules"
on policy_rules for all
to authenticated
using (exists (select 1 from print_policies pp where pp.id = policy_rules.policy_id and private.is_org_admin(pp.organization_id)))
with check (exists (select 1 from print_policies pp where pp.id = policy_rules.policy_id and private.is_org_admin(pp.organization_id)));

create policy "org_admins can manage quotas"
on quotas for all
to authenticated
using (private.is_org_admin(organization_id))
with check (private.is_org_admin(organization_id));

-- ============================================================================
-- print_jobs
-- ============================================================================
alter table print_jobs enable row level security;

-- Defense in depth mirroring packages/shared/src/job-state.ts ALLOWED_TRANSITIONS.
-- Runs for every UPDATE regardless of which client role performs it (RLS-governed
-- user session or service-role agent/admin code), so a bug in application code
-- cannot skip a state (e.g. approved -> completed directly).
create or replace function private.print_job_transition_allowed(from_status text, to_status text)
returns boolean
language sql
immutable
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
as $$
begin
  if new.status is distinct from old.status
     and not private.print_job_transition_allowed(old.status, new.status) then
    raise exception 'illegal print_jobs status transition: % -> %', old.status, new.status;
  end if;
  return new;
end;
$$;

create trigger print_jobs_validate_transition
  before update on print_jobs
  for each row execute function private.validate_print_job_transition();

create policy "users can view own jobs; approvers/admins view their org's jobs"
on print_jobs for select
to authenticated
using (
  created_by = (select auth.uid())
  or private.is_org_approver(organization_id)
);

create policy "members can create jobs in their own organization"
on print_jobs for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and organization_id in (select private.user_org_ids())
);

create policy "owners can update own jobs; approvers/admins update their org's jobs"
on print_jobs for update
to authenticated
using (
  created_by = (select auth.uid())
  or private.is_org_approver(organization_id)
)
with check (
  created_by = (select auth.uid())
  or private.is_org_approver(organization_id)
);

-- No delete policy: jobs are retired via status (cancelled/expired) and cleaned
-- up by the retention sweep (service-role), never hard-deleted by end users.

-- ============================================================================
-- print_job_events (append-only audit trail)
-- ============================================================================
alter table print_job_events enable row level security;

create policy "visibility mirrors the parent job"
on print_job_events for select
to authenticated
using (
  exists (
    select 1 from print_jobs j
    where j.id = print_job_events.job_id
      and (j.created_by = (select auth.uid()) or private.is_org_approver(j.organization_id))
  )
);

create policy "authenticated actors can append events on jobs they can act on"
on print_job_events for insert
to authenticated
with check (
  actor_id = (select auth.uid())
  and actor_type in ('user', 'admin')
  and exists (
    select 1 from print_jobs j
    where j.id = print_job_events.job_id
      and (j.created_by = (select auth.uid()) or private.is_org_approver(j.organization_id))
  )
);

-- No update/delete policy for anyone: this table is append-only by convention
-- and by grant (agent/system events are inserted via service-role, which must
-- still only ever INSERT here, never UPDATE/DELETE).

-- ============================================================================
-- approval_actions
-- ============================================================================
alter table approval_actions enable row level security;

create policy "visibility mirrors the parent job"
on approval_actions for select
to authenticated
using (
  exists (
    select 1 from print_jobs j
    where j.id = approval_actions.job_id
      and (j.created_by = (select auth.uid()) or private.is_org_approver(j.organization_id))
  )
);

create policy "approvers can record decisions on jobs in their org"
on approval_actions for insert
to authenticated
with check (
  approver_id = (select auth.uid())
  and exists (
    select 1 from print_jobs j
    where j.id = approval_actions.job_id and private.is_org_approver(j.organization_id)
  )
);

-- ============================================================================
-- monthly_usage
-- ============================================================================
alter table monthly_usage enable row level security;

create policy "users view own usage; org_admins view their org's usage"
on monthly_usage for select
to authenticated
using (user_id = (select auth.uid()) or private.is_org_admin(organization_id));

-- Quota reservation/consumption runs as the submitting user's own authenticated
-- session (see docs/architecture.md sec 14) so it stays RLS-governed rather than
-- needing service-role for an ordinary print submission.
create policy "users can reserve/consume their own usage row"
on monthly_usage for insert
to authenticated
with check (user_id = (select auth.uid()) or private.is_org_admin(organization_id));

create policy "users can update their own usage row; org_admins can adjust"
on monthly_usage for update
to authenticated
using (user_id = (select auth.uid()) or private.is_org_admin(organization_id))
with check (user_id = (select auth.uid()) or private.is_org_admin(organization_id));

create policy "org_admins can reset usage"
on monthly_usage for delete
to authenticated
using (private.is_org_admin(organization_id));

-- ============================================================================
-- audit_logs (immutable)
-- ============================================================================
alter table audit_logs enable row level security;

create policy "org_admins view their org's audit log; super_admins view platform log"
on audit_logs for select
to authenticated
using (
  (organization_id is not null and private.is_org_admin(organization_id))
  or (organization_id is null and private.is_super_admin())
);

create policy "org_admins can record their own actions"
on audit_logs for insert
to authenticated
with check (
  actor_id = (select auth.uid())
  and organization_id is not null
  and private.is_org_admin(organization_id)
);

-- No update/delete policy for anyone via RLS: immutable audit trail.

-- ============================================================================
-- remote_commands
-- ============================================================================
alter table remote_commands enable row level security;

create policy "org_admins can view their org's remote commands"
on remote_commands for select
to authenticated
using (private.is_org_admin(organization_id));

create policy "org_admins can issue remote commands"
on remote_commands for insert
to authenticated
with check (private.is_org_admin(organization_id) and issued_by = (select auth.uid()));

create policy "org_admins can cancel pending commands they issued"
on remote_commands for update
to authenticated
using (private.is_org_admin(organization_id))
with check (private.is_org_admin(organization_id));
