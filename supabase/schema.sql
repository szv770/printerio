-- Printio consolidated schema reference.
-- Generated from supabase/migrations/*.sql - migrations remain the source of truth.
-- Regenerate after adding a migration: run this same concatenation again.

-- ===================================================================
-- Source: migrations/0001_core_tables.sql
-- ===================================================================
-- Printio: organizations, membership, profiles, invitations, groups.
-- See docs/architecture.md sec 2 for the auth/bootstrap model.

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$'),
  -- UX hint only (prefill an invitation-request screen). Never used to grant
  -- membership or role - see docs/architecture.md sec 2.2.
  allowed_domains text[] not null default '{}',
  created_at timestamptz not null default now()
);

comment on column organizations.allowed_domains is
  'UX hint only - suggests this org on sign-in. Never grants membership or role.';

create table organization_settings (
  organization_id uuid primary key references organizations(id) on delete cascade,
  quota_basis text not null default 'physical_sheets'
    check (quota_basis in ('pdf_pages', 'printed_sides', 'physical_sheets', 'color_weighted')),
  default_policy_action text not null default 'require_approval'
    check (default_policy_action in ('allow', 'require_approval', 'deny')),
  job_approval_expiry_hours int not null default 72 check (job_approval_expiry_hours > 0),
  job_lease_minutes int not null default 10 check (job_lease_minutes > 0),
  retention_pending_days int check (retention_pending_days is null or retention_pending_days > 0),
  retention_completed_days int not null default 7 check (retention_completed_days > 0),
  retention_rejected_days int not null default 3 check (retention_rejected_days > 0),
  retention_failed_days int not null default 7 check (retention_failed_days > 0),
  max_upload_size_bytes bigint not null default 52428800 check (max_upload_size_bytes > 0), -- 50 MiB
  -- An org_admin's own print jobs bypass require_approval/deny policy
  -- outcomes and quota blocking by default (still tracked/shown as a
  -- warning, never silently) - see 0021_admin_bypass_restrictions.sql.
  admins_bypass_restrictions boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on column organization_settings.quota_basis is
  'Which computed metric quotas are measured in. Default physical_sheets - see '
  'docs/architecture.md sec 7.';

-- NOTE: the organization_settings_set_updated_at trigger (private.set_updated_at)
-- and the on_auth_user_created trigger (private.handle_new_auth_user, which
-- creates this row automatically) are both created in
-- 0005_extensions_and_helpers.sql, alongside the rest of the private.* helper
-- functions, once all referenced tables exist.

-- Mirrors auth.users 1:1. Never duplicates authentication identity - see
-- docs/architecture.md sec 2.1.
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  avatar_url text,
  -- Platform-level flag only. Grants no org-scoped access by itself.
  platform_role text not null default 'user' check (platform_role in ('user', 'super_admin')),
  created_at timestamptz not null default now()
);

create table organization_members (
  user_id uuid not null references profiles(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  role text not null default 'student'
    check (role in ('org_admin', 'approver', 'staff', 'student')),
  department text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  -- 0044: an org admin switched the early tools (print from a link, booklet builder) on for this person.
  early_tools boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, organization_id)
);

create index organization_members_org_idx on organization_members (organization_id);
create index organization_members_user_idx on organization_members (user_id);

-- Enrollment codes / targeted invitations. Redemption is a service-role server
-- action (never client-side RLS) that validates token/expiry/use-count and inserts
-- the organization_members row - see docs/architecture.md sec 2.2.
create table organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Exactly one of code/email is expected to be set by application logic:
  --   code  -> open enrollment code (any redeemer with the code, up to max_uses)
  --   email -> targeted invitation (only that email may redeem)
  code text unique,
  email text,
  role text not null default 'student'
    check (role in ('org_admin', 'approver', 'staff', 'student')),
  max_uses int check (max_uses is null or max_uses > 0),
  uses_count int not null default 0,
  expires_at timestamptz,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  constraint organization_invitations_code_or_email check (code is not null or email is not null)
);

create index organization_invitations_org_idx on organization_invitations (organization_id);

-- Departments/classes/custom cohorts. Membership is many-to-many via group_members
-- (a user may belong to multiple groups) - see docs/architecture.md sec re: spec's
-- groups/group_members tables.
create table groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  kind text not null default 'custom' check (kind in ('department', 'class', 'custom')),
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

create index groups_org_idx on groups (organization_id);

create table group_members (
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index group_members_user_idx on group_members (user_id);

-- ===================================================================
-- Source: migrations/0002_printing_tables.sql
-- ===================================================================
-- Printio: agents, printers, printer profiles (Windows queue mapping), policies.
-- See docs/architecture.md sec 4 (agent auth) and sec 9 (driver/finishing architecture).

create table agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  -- Salted hash of the device credential. The plaintext secret is shown to the
  -- admin exactly once at registration/rotation time and never stored.
  device_secret_hash text,
  -- One-time enrollment code exchanged for a device secret on first run.
  -- Cleared once redeemed.
  enrollment_code text unique,
  enrollment_code_expires_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  version text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index agents_org_idx on agents (organization_id);

create table printers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  vendor text,
  model text,
  location text,
  status text not null default 'unknown' check (status in ('unknown', 'online', 'offline', 'error')),
  last_status_at timestamptz,
  -- 0047: the printer's own last status message and PJL code, as reported by the print agent (display only).
  status_detail text check (status_detail is null or char_length(status_detail) <= 200),
  status_code integer check (status_code is null or status_code between 0 and 99999),
  -- Model-specific SNMP OID overrides (never hardcoded across models - see
  -- docs/architecture.md sec 9 / known-limitations.md). Null/empty = SNMP telemetry
  -- disabled for this printer; printing is unaffected either way.
  snmp_config jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index printers_org_idx on printers (organization_id);

-- Logical print profile -> Windows queue mapping. Finishing options are baked into
-- the Windows queue's driver "Printing Defaults" out-of-band (see printer-setup.md);
-- Printio never programs finishing options itself. windows_queue_name is only ever
-- resolved server-side/agent-side, never sent to an untrusted client - see
-- docs/architecture.md sec 9.
create table printer_profiles (
  id uuid primary key default gen_random_uuid(),
  printer_id uuid not null references printers(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete restrict,
  key text not null check (key ~ '^[a-z0-9_]+$'),
  label text not null check (char_length(label) between 1 and 200),
  windows_queue_name text,
  -- 0027: 'raw' = send straight to raw_host:raw_port (PJL + PDF) instead of a Windows queue.
  output_mode text not null default 'queue' check (output_mode in ('queue', 'raw')),
  raw_host text,
  raw_port integer not null default 9100 check (raw_port between 1 and 65535),
  raw_staple_position text not null default 'top-left' check (raw_staple_position in ('top-left', 'top-right')),
  -- Administrator-declared, not cloud-verified against the physical device -
  -- see docs/architecture.md sec 9.
  declared_paper_sizes text[] not null default '{letter}',
  declared_capabilities jsonb not null default
    '{"duplex": false, "color": false, "staple": false, "booklet": false, "punch": false}',
  -- Optional per-side/per-sheet pricing for this profile (spec sec 42). Null = no
  -- cost tracking configured; organizations may track pages/sheets with no
  -- financial dimension at all.
  pricing jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (printer_id, key)
);

create index printer_profiles_printer_idx on printer_profiles (printer_id);
create index printer_profiles_agent_idx on printer_profiles (agent_id);

create table print_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  applies_to_role text[], -- optional simple targeting, in addition to rule conditions
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create index print_policies_org_idx on print_policies (organization_id);

-- See docs/architecture.md sec 6 for the rule shape and precedence model.
-- `conditions` is a JSON array of {field, op, value} objects, implicitly AND-ed.
-- Valid field/op tokens are validated at the application layer
-- (packages/shared/src/policy-engine.ts) rather than by a DB CHECK, since the set
-- of supported fact fields is expected to grow.
create table policy_rules (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references print_policies(id) on delete cascade,
  action text not null check (action in ('allow', 'require_approval', 'deny')),
  conditions jsonb not null default '[]',
  reason_label text not null check (char_length(reason_label) between 1 and 300),
  priority int not null default 100,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create index policy_rules_policy_idx on policy_rules (policy_id);

-- Configurable quotas (spec sec 31/32). scope_value's meaning depends on scope_type:
--   role         -> one of organization_members.role
--   department   -> organization_members.department
--   group        -> groups.id (as text)
--   user         -> profiles.id (as text)
--   organization -> null (org-wide cap)
create table quotas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  scope_type text not null check (scope_type in ('role', 'department', 'group', 'user', 'organization')),
  scope_value text,
  period text not null default 'monthly' check (period in ('monthly')),
  limit_value int not null check (limit_value > 0),
  created_at timestamptz not null default now(),
  constraint quotas_scope_value_required check (
    (scope_type = 'organization' and scope_value is null) or
    (scope_type <> 'organization' and scope_value is not null)
  )
);

create index quotas_org_idx on quotas (organization_id);

-- ===================================================================
-- Source: migrations/0003_jobs_tables.sql
-- ===================================================================
-- Printio: print jobs, audit trail, approvals, monthly usage.
-- Status/event-type values must stay in sync with
-- packages/shared/src/job-state.ts (JOB_STATES / JOB_EVENT_TYPES).
-- See docs/architecture.md sec 13 (state machine / leasing) and sec 14 (quotas).

create sequence if not exists print_jobs_number_seq;

create table print_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Human-readable id for logs/support, e.g. JOB-2026-000184 (spec sec 35/41).
  job_number text not null unique default (
    'JOB-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('print_jobs_number_seq')::text, 6, '0')
  ),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid not null references profiles(id),
  printer_id uuid references printers(id),
  printer_profile_id uuid references printer_profiles(id),

  status text not null default 'draft' check (status in (
    'draft', 'pending_approval', 'approved', 'denied', 'rejected', 'expired',
    'cancelled', 'claimed', 'downloading', 'downloaded', 'printing',
    'submitted_to_spooler', 'completed', 'failed'
  )),

  -- Storage paths (private bucket, org-scoped - see docs/architecture.md sec 3.3).
  -- Never modified once written; a booklet-padded (or other) transformation
  -- always produces a new derived_file_path, never overwrites original_file_path.
  original_file_path text not null,
  derived_file_path text,
  original_file_name text not null,

  -- Server-verified facts. Never trust client-supplied values for any of these
  -- (see docs/architecture.md sec 3.2 / sec 5).
  source_pdf_pages int not null check (source_pdf_pages > 0),
  file_size_bytes bigint not null check (file_size_bytes > 0),
  copies int not null default 1 check (copies > 0),
  color_mode text not null default 'bw' check (color_mode in ('bw', 'color')),
  duplex boolean not null default false,
  paper_size text not null default 'letter',
  finishing jsonb not null default '{"staple": false, "booklet": false, "punch": false}',
  booklet_padding_added int not null default 0 check (booklet_padding_added >= 0),

  -- Computed print math (docs/architecture.md sec 7). Populated at submission time.
  estimated_printed_sides int not null check (estimated_printed_sides > 0),
  estimated_physical_sheets int not null check (estimated_physical_sheets > 0),
  estimated_cost_cents int check (estimated_cost_cents is null or estimated_cost_cents >= 0),

  -- Policy engine result, stored for audit (docs/architecture.md sec 6.3).
  policy_action text check (policy_action in ('allow', 'require_approval', 'deny')),
  policy_reasons text[] not null default '{}',
  -- True only when organization_settings.admins_bypass_restrictions overrode
  -- what policy_action/policy_reasons above would otherwise have done (e.g.
  -- policy_action = 'deny' but this job was still approved) - see
  -- 0021_admin_bypass_restrictions.sql. Never true alongside policy_action =
  -- 'allow', since there was nothing to bypass.
  policy_bypassed_for_admin boolean not null default false,

  -- Job leasing (docs/architecture.md sec 13). Only one agent may hold a job.
  lease_owner_agent_id uuid references agents(id),
  lease_expires_at timestamptz,

  attempt_count int not null default 0 check (attempt_count >= 0),
  max_attempts int not null default 3 check (max_attempts > 0),
  error_message text,

  approved_at timestamptz,
  approved_by uuid references profiles(id),
  completed_at timestamptz,
  -- Deadline for a pending_approval job before it auto-expires
  -- (organization_settings.job_approval_expiry_hours).
  expires_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index print_jobs_org_idx on print_jobs (organization_id);
create index print_jobs_created_by_idx on print_jobs (created_by);
create index print_jobs_status_idx on print_jobs (organization_id, status);
create index print_jobs_lease_idx on print_jobs (lease_owner_agent_id) where lease_owner_agent_id is not null;

-- NOTE: the print_jobs_set_updated_at trigger (private.set_updated_at) is created
-- in 0005_extensions_and_helpers.sql alongside the rest of the private.* helpers.

-- Immutable audit trail (spec sec 41). No update/delete grant beyond service-role -
-- see 0006_rls_policies.sql.
create table print_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references print_jobs(id) on delete cascade,
  event_type text not null check (event_type in (
    'JOB_CREATED', 'PDF_UPLOADED', 'PREFLIGHT_COMPLETED', 'PREFLIGHT_REJECTED',
    'POLICY_EVALUATED', 'APPROVAL_REQUIRED', 'APPROVED', 'REJECTED', 'DENIED',
    'JOB_EXPIRED', 'JOB_CANCELLED', 'AGENT_CLAIMED', 'LEASE_EXPIRED',
    'DOWNLOAD_STARTED', 'DOWNLOAD_COMPLETED', 'PRINT_SUBMITTED', 'SPOOLER_ACCEPTED',
    'PRINT_FAILED', 'JOB_COMPLETED', 'RETRY_SCHEDULED'
  )),
  actor_type text not null check (actor_type in ('user', 'system', 'agent', 'admin')),
  actor_id uuid,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index print_job_events_job_idx on print_job_events (job_id, created_at);

create table approval_actions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references print_jobs(id) on delete cascade,
  approver_id uuid not null references profiles(id),
  decision text not null check (decision in ('approved', 'rejected')),
  reason text,
  created_at timestamptz not null default now()
);

create index approval_actions_job_idx on approval_actions (job_id);

-- Per-user, per-org, per-month usage + in-flight reservations (docs/architecture.md
-- sec 14). reserved_* is incremented at submission time under a row lock and
-- released/converted to *_used on the job's terminal outcome.
create table monthly_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  period text not null check (period ~ '^\d{4}-\d{2}$'), -- 'YYYY-MM'
  pdf_pages_used int not null default 0 check (pdf_pages_used >= 0),
  printed_sides_used int not null default 0 check (printed_sides_used >= 0),
  physical_sheets_used int not null default 0 check (physical_sheets_used >= 0),
  color_weighted_used int not null default 0 check (color_weighted_used >= 0),
  reserved_pdf_pages int not null default 0 check (reserved_pdf_pages >= 0),
  reserved_printed_sides int not null default 0 check (reserved_printed_sides >= 0),
  reserved_physical_sheets int not null default 0 check (reserved_physical_sheets >= 0),
  reserved_color_weighted int not null default 0 check (reserved_color_weighted >= 0),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, period)
);

create index monthly_usage_org_idx on monthly_usage (organization_id, period);

-- NOTE: the monthly_usage_set_updated_at trigger (private.set_updated_at) is
-- created in 0005_extensions_and_helpers.sql alongside the rest of the
-- private.* helpers.

-- ===================================================================
-- Source: migrations/0004_admin_tables.sql
-- ===================================================================
-- Printio: security-sensitive admin audit log + the remote-command allowlist.
-- See docs/architecture.md sec 12 (no arbitrary remote command execution).

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade, -- null = platform-level action
  actor_id uuid references profiles(id),
  action text not null check (char_length(action) between 1 and 200),
  target_type text,
  target_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_logs_org_idx on audit_logs (organization_id, created_at);

-- Fixed, allow-listed remote commands only - never a raw shell/PowerShell string.
-- The Agent's command handler is a switch over this exact set
-- (apps/agent/src/commands.ts); adding a new command means adding both a DB enum
-- value here and a handler case there, in the same change.
create table remote_commands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  printer_id uuid references printers(id),
  command text not null check (command in (
    'REFRESH_PRINTER_STATUS', 'CANCEL_PRINT_JOB', 'RESTART_PRINT_QUEUE',
    'RESTART_AGENT_SERVICE', 'CLEAR_AGENT_TEMP_FILES'
  )),
  payload jsonb not null default '{}',
  issued_by uuid not null references profiles(id),
  status text not null default 'pending' check (status in ('pending', 'acknowledged', 'completed', 'failed')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index remote_commands_agent_idx on remote_commands (agent_id, status);

-- ===================================================================
-- Source: migrations/0005_extensions_and_helpers.sql
-- ===================================================================
-- Printio: extensions, private schema, RLS helper functions, and the small set
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

-- ===================================================================
-- Source: migrations/0006_rls_policies.sql
-- ===================================================================
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

-- 0045: a member cannot change profiles.email (it mirrors the sign-in address); one profile per address.
create or replace function private.prevent_profile_email_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.email is distinct from old.email
     and coalesce(auth.role(), 'anon') <> 'service_role' then
    raise exception 'email can only be changed by a service-role operation';
  end if;
  return new;
end;
$$;
create trigger profiles_prevent_email_change
  before update on public.profiles
  for each row execute function private.prevent_profile_email_change();
create unique index profiles_email_lower_key on public.profiles (lower(email));

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

-- ===================================================================
-- Source: migrations/0007_storage.sql
-- ===================================================================
-- Printio: private storage bucket + path-scoped RLS.
-- Path convention: org/{organizationId}/jobs/{jobId}/original.pdf|derived.pdf
-- See docs/architecture.md sec 3.3. Never a public bucket; downloads always go
-- through createSignedUrl(), never a public URL.

insert into storage.buckets (id, name, public, file_size_limit)
values ('print-jobs', 'print-jobs', false, 104857600) -- 100 MiB hard ceiling; per-org
                                                       -- limits are enforced at the
                                                       -- application layer from
                                                       -- organization_settings.max_upload_size_bytes
on conflict (id) do nothing;

create policy "org members can read their org's job files"
on storage.objects for select
to authenticated
using (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
);

create policy "org members can upload their org's job files"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
);

-- Derived files (e.g. booklet padding) are written by server-side application
-- code as the requesting user, so update is allowed under the same scope; the
-- original upload itself is never overwritten by application logic (a new
-- object path is used for derived files) - this policy exists for storage
-- housekeeping only (e.g. re-running a failed derived-file generation).
create policy "org members can update their org's job files"
on storage.objects for update
to authenticated
using (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
)
with check (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
);

create policy "org_admins can delete their org's job files"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and private.is_org_admin((storage.foldername(name))[2]::uuid)
);

-- Note: the retention-policy cleanup sweep (docs/architecture.md sec 16/§33 of the
-- spec) runs as a service-role Vercel Cron job and therefore does not depend on
-- this delete policy; this policy only covers ad-hoc admin deletes from the
-- dashboard.

-- ===================================================================
-- Source: migrations/0008_realtime.sql
-- ===================================================================
-- Printio: Realtime Authorization for private, per-organization channels.
-- See docs/architecture.md sec 3.4.
--
-- Topic convention: 'org-{organizationId}:{stream}', e.g.
--   org-<uuid>:jobs        (job status changes)
--   org-<uuid>:approvals   (approval queue add/remove)
--   org-<uuid>:agents      (agent online/offline)
--
-- Operational note (not SQL, do at project setup time - see docs/deployment.md):
-- disable "Allow public access" in Supabase Dashboard -> Realtime -> Settings so
-- no unauthenticated/public channel can be joined at all, as defense in depth on
-- top of these policies. Every client-side subscribe call must pass
-- { config: { private: true } } for these policies to be consulted.

create policy "org members can receive broadcast on their org's channels"
on realtime.messages for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and exists (
    select 1 from organization_members m
    where m.user_id = (select auth.uid())
      and m.status = 'active'
      and (select realtime.topic()) like ('org-' || m.organization_id::text || ':%')
  )
);

create policy "org members can send broadcast on their org's channels"
on realtime.messages for insert
to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and exists (
    select 1 from organization_members m
    where m.user_id = (select auth.uid())
      and m.status = 'active'
      and (select realtime.topic()) like ('org-' || m.organization_id::text || ':%')
  )
);

-- Note: postgres_changes subscriptions (used for a couple of simple list-refresh
-- cases, e.g. print_jobs) need no separate policy here - visibility is governed
-- by RLS on the source table itself (0006_rls_policies.sql), which is consulted
-- per-row by the Realtime server. This gives defense in depth: even a
-- misconfigured broadcast-channel policy could not leak rows a user's own table
-- RLS would not otherwise show them.

-- ===================================================================
-- Source: migrations/0009_lint_fixes.sql
-- ===================================================================
-- Printio: fixes for Supabase database-linter findings surfaced by get_advisors
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
-- safety net - it was not created by any Printio migration and is left alone.

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

-- 0023_fix_print_job_transition_trigger_privileges.sql: this trigger function
-- calls private.print_job_transition_allowed(), but an ordinary `authenticated`
-- role has no USAGE grant on schema `private` at all - so without
-- SECURITY DEFINER, any real user's status-changing UPDATE (approve, reject,
-- ...) failed outright with "permission denied for schema private" the
-- instant it was first exercised. The earlier search_path hardening pass
-- below added `set search_path = ''` but missed that this one - unlike a
-- plain helper function, a trigger body needing to reach into `private`
-- needs SECURITY DEFINER too. The print_jobs RLS UPDATE policy still fully
-- governs who may write the row at all; this only validates the transition
-- shape.
create or replace function private.validate_print_job_transition()
returns trigger
language plpgsql
security definer
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

-- ===================================================================
-- Source: migrations/0010_quota_functions.sql
-- ===================================================================
-- Printio: atomic quota reserve/release/consume.
-- See docs/architecture.md sec 14 - a single UPDATE ... WHERE <limit check>
-- is atomic per-row in Postgres, so two concurrent submissions from the same
-- user cannot both read a stale "under quota" snapshot and both succeed: the
-- second UPDATE re-evaluates the WHERE clause against the first one's
-- already-committed increment.
--
-- SECURITY INVOKER (the default - no `security definer` here) deliberately:
-- this runs as the calling user's own authenticated session, so it stays
-- governed by the existing monthly_usage RLS policies (a user may only ever
-- adjust their own row, or an org_admin any row in their org) rather than
-- needing service-role for an ordinary print submission.
create or replace function adjust_monthly_usage(
  p_organization_id uuid,
  p_user_id uuid,
  p_period text,
  p_pdf_pages int,
  p_printed_sides int,
  p_physical_sheets int,
  p_color_weighted int,
  p_quota_basis text,
  p_limit int, -- null = no quota configured for this scope (always allowed)
  p_mode text  -- 'reserve' | 'release' | 'consume'
)
returns boolean
language plpgsql
as $$
declare
  v_rows int;
begin
  if p_mode not in ('reserve', 'release', 'consume') then
    raise exception 'invalid adjust_monthly_usage mode: %', p_mode;
  end if;

  insert into monthly_usage (organization_id, user_id, period)
  values (p_organization_id, p_user_id, p_period)
  on conflict (organization_id, user_id, period) do nothing;

  if p_mode = 'release' then
    update monthly_usage set
      reserved_pdf_pages = greatest(0, reserved_pdf_pages - p_pdf_pages),
      reserved_printed_sides = greatest(0, reserved_printed_sides - p_printed_sides),
      reserved_physical_sheets = greatest(0, reserved_physical_sheets - p_physical_sheets),
      reserved_color_weighted = greatest(0, reserved_color_weighted - p_color_weighted)
    where organization_id = p_organization_id and user_id = p_user_id and period = p_period;
    return true;
  end if;

  if p_mode = 'consume' then
    update monthly_usage set
      reserved_pdf_pages = greatest(0, reserved_pdf_pages - p_pdf_pages),
      reserved_printed_sides = greatest(0, reserved_printed_sides - p_printed_sides),
      reserved_physical_sheets = greatest(0, reserved_physical_sheets - p_physical_sheets),
      reserved_color_weighted = greatest(0, reserved_color_weighted - p_color_weighted),
      pdf_pages_used = pdf_pages_used + p_pdf_pages,
      printed_sides_used = printed_sides_used + p_printed_sides,
      physical_sheets_used = physical_sheets_used + p_physical_sheets,
      color_weighted_used = color_weighted_used + p_color_weighted
    where organization_id = p_organization_id and user_id = p_user_id and period = p_period;
    return true;
  end if;

  -- p_mode = 'reserve'
  if p_limit is null then
    update monthly_usage set
      reserved_pdf_pages = reserved_pdf_pages + p_pdf_pages,
      reserved_printed_sides = reserved_printed_sides + p_printed_sides,
      reserved_physical_sheets = reserved_physical_sheets + p_physical_sheets,
      reserved_color_weighted = reserved_color_weighted + p_color_weighted
    where organization_id = p_organization_id and user_id = p_user_id and period = p_period;
    return true;
  end if;

  update monthly_usage set
    reserved_pdf_pages = reserved_pdf_pages + p_pdf_pages,
    reserved_printed_sides = reserved_printed_sides + p_printed_sides,
    reserved_physical_sheets = reserved_physical_sheets + p_physical_sheets,
    reserved_color_weighted = reserved_color_weighted + p_color_weighted
  where organization_id = p_organization_id and user_id = p_user_id and period = p_period
    and (
      case p_quota_basis
        when 'pdf_pages' then pdf_pages_used + reserved_pdf_pages + p_pdf_pages
        when 'printed_sides' then printed_sides_used + reserved_printed_sides + p_printed_sides
        when 'physical_sheets' then physical_sheets_used + reserved_physical_sheets + p_physical_sheets
        when 'color_weighted' then color_weighted_used + reserved_color_weighted + p_color_weighted
        else physical_sheets_used + reserved_physical_sheets + p_physical_sheets
      end
    ) <= p_limit;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function adjust_monthly_usage is
  'Atomic quota reserve/release/consume - see docs/architecture.md sec 14. '
  'SECURITY INVOKER: runs as the caller, governed by monthly_usage RLS.';

-- ===================================================================
-- Source: migrations/0011_realtime_publication.sql
-- ===================================================================
-- Printio: enable postgres_changes realtime for the tables the V1 UI
-- subscribes to directly (docs/architecture.md sec 3.4/15).
--
-- Implementation note: the architecture doc describes private broadcast
-- channels (org-{id}:stream, see 0008_realtime.sql) as the recommended
-- pattern for high-scale fan-out. For this build's single-organization
-- scope, subscribing directly to postgres_changes on print_jobs/agents is
-- simpler, needs no custom server-side broadcast-sending code, and is
-- exactly as secure - visibility is still governed entirely by each table's
-- own RLS policies (0006_rls_policies.sql), so org A's client still cannot
-- receive org B's row changes. The broadcast-channel policies from
-- 0008_realtime.sql remain in place and are the natural next step if/when
-- fan-out volume justifies the extra complexity.
alter publication supabase_realtime add table print_jobs;
alter publication supabase_realtime add table agents;
alter publication supabase_realtime add table remote_commands;


-- ===================================================================
-- Source: migrations/0012_rate_limiting.sql
-- ===================================================================
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


-- ===================================================================
-- Source: migrations/0013_domain_restriction_and_reauth.sql
-- ===================================================================
-- Printio: enforce organizations.allowed_domains as an actual sign-in gate,
-- and add profiles.last_authenticated_at to support forcing a full
-- interactive re-authentication at least every 30 days, independent of
-- Supabase's own refresh-token lifetime. See docs/architecture.md sec 19 for
-- the full design rationale (this migration adds that section; the previous
-- sec 19 "What this system does not guarantee" is renumbered to sec 20).
--
-- Why this doesn't contradict sec 2.2's "no auto-admin-by-domain" rule: that
-- rule is about *authorization* - nothing about a Google OAuth login can, by
-- itself, imply an organization_id or role. This migration adds a gate on
-- whether sign-in is allowed to *proceed* at all for a brand-new user, which
-- is a different, narrower thing: passing the gate grants no
-- organization_members row, no role, nothing - it only decides whether the
-- user reaches the existing enrollment-code flow (app/no-access) instead of
-- being signed back out immediately. Actual admission remains, unconditionally,
-- the organization_invitations flow.

-- ============================================================================
-- 30-day forced re-authentication
-- ============================================================================
-- Checked independently of Supabase's own token expiry, in
-- apps/web/lib/auth/session.ts's getCurrentSession() on every session load
-- (apps/web/lib/auth/reauth.ts holds the pure isReauthRequired() check).
alter table profiles add column last_authenticated_at timestamptz;

-- Backfill so existing users aren't immediately force-logged-out the moment
-- this migration ships - a null timestamp reads as "expired" (fail closed,
-- see lib/auth/reauth.ts), so every current profile is treated as freshly
-- authenticated as of this migration; the 30-day clock starts now for
-- everyone, not retroactively from whenever they actually last signed in.
update profiles set last_authenticated_at = now() where last_authenticated_at is null;

comment on column profiles.last_authenticated_at is
  'Set to now() only by a real interactive OAuth code exchange '
  '(apps/web/app/auth/callback/route.ts) - never by the silent background '
  'token refresh that runs on every request (proxy.ts / '
  'lib/supabase/middleware.ts only calls auth.getUser(), never '
  'exchangeCodeForSession). getCurrentSession() signs the user out and '
  'redirects to /login?reason=reauth_required once this is more than 30 '
  'days old, regardless of how fresh the refresh token itself still is - '
  'see docs/architecture.md sec 19.';

-- ============================================================================
-- allowed_domains: from UX hint to an enforced (but narrow) sign-in gate
-- ============================================================================
-- Supersedes the 0001_core_tables.sql column comment ("UX hint only ... never
-- grants membership or role"). That specific invariant about membership/role
-- still holds byte-for-byte - email_domain_allowed() below returns a boolean
-- and nothing else - but the column is no longer read only to prefill a UI
-- hint; it is now actually enforced for brand-new sign-ins.
comment on column organizations.allowed_domains is
  'Enforced sign-in gate for a user with no existing active '
  'organization_members row (see apps/web/app/auth/callback/route.ts and '
  'email_domain_allowed() below). Empty array (the default) means '
  'unrestricted - any domain may attempt to join. Never grants membership or '
  'role by itself: actual admission is always the organization_invitations '
  'flow (docs/architecture.md sec 2.2). Editable by an org_admin via '
  'app/admin/settings.';

-- Callable by the signed-in user's own client (never service-role - see
-- docs/architecture.md's RLS invariants), even before that user has any
-- organization_members row and so cannot SELECT organizations directly (the
-- "members can view their organizations" policy requires membership).
-- SECURITY DEFINER, and deliberately in the public schema like
-- check_rate_limit (not private.*) so PostgREST exposes it for
-- supabase.rpc() from the callback route. Takes no arguments - it reads the
-- caller's own auth.uid()/email server-side rather than trusting a
-- client-supplied email, per this repo's "never trust client-supplied
-- identity" rule (docs/architecture.md sec 3.2). Returns only a boolean,
-- never row data, so it cannot be used to enumerate other organizations'
-- domains.
create or replace function email_domain_allowed()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_domain text;
begin
  -- Existing members are never gated by domain on sign-in - an admin may
  -- have deliberately invited an exception, or allowed_domains may have been
  -- tightened after this person already joined. Domain-check gates *new*
  -- joins only, never silently locks out an existing member.
  if exists (
    select 1 from public.organization_members
    where user_id = auth.uid() and status = 'active'
  ) then
    return true;
  end if;

  select email into v_email from auth.users where id = auth.uid();
  v_domain := lower(split_part(coalesce(v_email, ''), '@', 2));
  if v_domain = '' then
    return false;
  end if;

  -- No organization exists yet: this is the PRINTIO_BOOTSTRAP_ADMIN_EMAIL
  -- first-sign-in path (apps/web/lib/auth/bootstrap.ts) - allowed_domains
  -- doesn't exist to check against yet, so this must not block it.
  if not exists (select 1 from public.organizations) then
    return true;
  end if;

  -- Otherwise: allowed if ANY organization either has not configured a
  -- restriction (empty array - the schema default, meaning "not yet
  -- configured by an admin") or explicitly lists this domain. This only
  -- decides whether the user reaches the enrollment-code screen
  -- (app/no-access) - it grants no membership or role.
  return exists (
    select 1 from public.organizations o
    where o.allowed_domains = '{}' or v_domain = any(o.allowed_domains)
  );
end;
$$;

comment on function email_domain_allowed is
  'Sign-in domain gate for brand-new users (see '
  'apps/web/app/auth/callback/route.ts). Always true for anyone with an '
  'existing active organization_members row. Grants no organization_id or '
  'role by itself - see docs/architecture.md sec 19.';

-- Callable by any authenticated user checking their own sign-in eligibility.
-- Not granted to anon - exchangeCodeForSession must succeed (an authenticated
-- session must exist) before this is ever called.
grant execute on function email_domain_allowed() to authenticated;


-- ===================================================================
-- Source: migrations/0014_magic_link_domain_toggle.sql
-- ===================================================================
-- Printio: add Supabase magic-link (email OTP) sign-in as a second sign-in
-- method alongside Google OAuth, and give an org_admin a per-organization
-- toggle over whether magic-link sign-ins are subject to the same
-- allowed_domains gate that Google OAuth sign-ins already go through
-- unconditionally. See docs/architecture.md sec 19.3 for the full design
-- rationale.
--
-- This is deliberately NOT a change to email_domain_allowed() or to Google
-- OAuth's behavior in any way - that function, and the gate it enforces, stay
-- exactly as they are today (0013_domain_restriction_and_reauth.sql), always
-- checked for a Google-OAuth-originated sign-in, with no toggle and no way to
-- turn it off. This migration only adds a second, independent function for
-- the second sign-in method, so a mistake here cannot regress the existing
-- Google gate.
--
-- Same invariant as 0013's, restated because it's the one this migration
-- must not violate either: passing this gate grants no organization_members
-- row, no role, nothing - it only decides whether exchangeCodeForSession's
-- result is allowed to stand for a brand-new user (apps/web/app/auth/
-- callback/route.ts), rather than being signed back out immediately. Actual
-- admission remains, unconditionally, the organization_invitations flow.

-- ============================================================================
-- Per-org toggle
-- ============================================================================
-- Defaults to true (the same restriction Google OAuth already enforces) so a
-- newly-created organization - and every organization that exists today,
-- before this feature shipped - does not suddenly become MORE open than it
-- was a moment ago just because this column appeared. An org_admin opts in to
-- the looser behavior explicitly, from app/admin/settings; nothing flips it
-- open by default.
alter table organizations
  add column magic_link_requires_allowed_domain boolean not null default true;

comment on column organizations.magic_link_requires_allowed_domain is
  'Whether magic-link (email OTP) sign-in for a brand-new user is subject to '
  'this organization''s allowed_domains list, the same way Google OAuth '
  'sign-in always is (see email_domain_allowed_for_magic_link() below). '
  'Defaults to true - same restriction Google OAuth already has - so this '
  'column cannot make an organization more open than it was before this '
  'feature existed unless an org_admin explicitly turns it off from '
  'app/admin/settings. Turning it off does not grant membership or role by '
  'itself, same as allowed_domains itself never has (docs/architecture.md '
  'sec 19.1) - it only widens who reaches the existing enrollment-code flow '
  '(app/no-access) via the magic-link method specifically. Has no effect on '
  'Google OAuth sign-in, which is never gated by this column.';

-- ============================================================================
-- email_domain_allowed_for_magic_link(): the magic-link sign-in gate
-- ============================================================================
-- Deliberately a separate function from email_domain_allowed() rather than a
-- parameterized version of it - the two methods' gates are independent
-- product decisions (an org_admin can loosen magic-link without touching
-- Google's gate at all), and keeping them as separate functions means a bug
-- in one cannot silently change the other's behavior.
--
-- Mirrors email_domain_allowed()'s shape exactly for the first two checks
-- (copied verbatim, not reimplemented) and only diverges for the actual
-- per-org domain check, where it additionally consults
-- magic_link_requires_allowed_domain:
--
--   - An organization with the toggle OFF unconditionally allows any domain
--     for magic-link purposes, regardless of what allowed_domains contains -
--     the toggle is specifically an override for this sign-in method, not a
--     second copy of the domain list to keep in sync.
--   - An organization with the toggle ON (the default) is checked against
--     allowed_domains exactly like email_domain_allowed() checks it today
--     (empty array = unrestricted; otherwise the domain must be listed).
--
-- Multi-org shape: this deployment is single-org today, but the OR-across-
-- organizations shape below is chosen to stay correct if a second
-- organization existed, and it deliberately mirrors the OR shape
-- email_domain_allowed() already uses (allowed if ANY organization would
-- allow it) rather than inventing a different combination rule for the same
-- kind of question: allowed if ANY organization either has the toggle off
-- (unconditional allow for that org), or has the toggle on with an
-- allowed_domains list that would allow this domain. A domain rejected by
-- every organization's magic-link policy is rejected overall - same
-- "any organization is enough to let a brand-new user reach the
-- enrollment-code screen" reasoning as the existing function, just extended
-- with one more per-org condition to check.
create or replace function email_domain_allowed_for_magic_link()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_domain text;
begin
  -- Existing members are never gated by domain on sign-in, regardless of
  -- method - identical rationale and identical check to
  -- email_domain_allowed() (copied verbatim, not reimplemented).
  if exists (
    select 1 from public.organization_members
    where user_id = auth.uid() and status = 'active'
  ) then
    return true;
  end if;

  select email into v_email from auth.users where id = auth.uid();
  v_domain := lower(split_part(coalesce(v_email, ''), '@', 2));
  if v_domain = '' then
    return false;
  end if;

  -- No organization exists yet: same bootstrap-path carve-out as
  -- email_domain_allowed() - allowed_domains/magic_link_requires_allowed_domain
  -- don't exist to check against yet, so this must not block
  -- PRINTIO_BOOTSTRAP_ADMIN_EMAIL's first sign-in (lib/auth/bootstrap.ts),
  -- however that first sign-in happens to arrive.
  if not exists (select 1 from public.organizations) then
    return true;
  end if;

  -- Otherwise: allowed if ANY organization either has turned the toggle off
  -- (unconditional allow for magic-link purposes, this org's allowed_domains
  -- notwithstanding) or has the toggle on and would allow this domain via the
  -- same allowed_domains logic email_domain_allowed() uses (empty array = not
  -- yet configured = unrestricted; otherwise the domain must be listed).
  -- Grants no membership or role - only decides whether this brand-new user
  -- reaches app/no-access's existing enrollment-code flow.
  return exists (
    select 1 from public.organizations o
    where o.magic_link_requires_allowed_domain = false
       or o.allowed_domains = '{}'
       or v_domain = any(o.allowed_domains)
  );
end;
$$;

comment on function email_domain_allowed_for_magic_link is
  'Sign-in domain gate for brand-new users arriving via magic-link (email '
  'OTP) sign-in specifically - see apps/web/app/auth/callback/route.ts, '
  'which branches on the detected sign-in provider to call this instead of '
  'email_domain_allowed() for a magic-link-originated session. Always true '
  'for anyone with an existing active organization_members row. Honors '
  'each organization''s magic_link_requires_allowed_domain toggle (default '
  'true = same restriction as Google OAuth); an organization with the '
  'toggle off allows any domain to reach the magic-link flow. Grants no '
  'organization_id or role by itself - see docs/architecture.md sec 19.3.';

-- Same grant shape as email_domain_allowed(): callable by any authenticated
-- user checking their own sign-in eligibility, not granted to anon -
-- exchangeCodeForSession must succeed (an authenticated session must exist)
-- before this is ever called.
grant execute on function email_domain_allowed_for_magic_link() to authenticated;


-- ===================================================================
-- Source: migrations/0015_retention_files_purged_at.sql
-- ===================================================================
-- Printio: `files_purged_at` marks a print_jobs row whose Storage files have
-- already been removed by the retention sweep
-- (apps/web/app/api/cron/sweep/route.ts), so a job past its retention
-- window whose files are already gone stops being re-selected (and
-- storage.remove() re-called) on every subsequent sweep tick forever. The
-- route's own inline comment already named this exact gap before this
-- migration existed - see docs/architecture.md sec 16. The job row itself
-- is still never deleted (job_number/audit history survives, per the
-- route's existing retention comment); only this marker is new.
alter table print_jobs add column files_purged_at timestamptz;

comment on column print_jobs.files_purged_at is
  'Set once the retention sweep (app/api/cron/sweep/route.ts) has removed '
  'this job''s Storage objects (original_file_path/derived_file_path). Null '
  'means either the files still exist or the job is not yet past its '
  'retention window. Filtered out (`is null`) by the sweep''s selection '
  'query so an already-purged job is never re-selected/re-processed on '
  'every future tick - see docs/architecture.md sec 16.';


-- ===================================================================
-- Source: migrations/0016_protect_last_authenticated_at.sql
-- ===================================================================
-- Fix: profiles.last_authenticated_at was updatable by any authenticated
-- client via the existing "users can update own profile" RLS policy (that
-- policy only restricts which ROW a user can touch, not which columns).
-- Mirrors the existing platform_role protection pattern above.
create or replace function private.prevent_last_authenticated_at_tampering()
returns trigger
language plpgsql
as $$
begin
  if new.last_authenticated_at is distinct from old.last_authenticated_at
     and coalesce(auth.role(), 'anon') <> 'service_role' then
    raise exception 'last_authenticated_at can only be changed by a service-role operation';
  end if;
  return new;
end;
$$;

create trigger profiles_prevent_last_authenticated_at_tampering
  before update on profiles
  for each row execute function private.prevent_last_authenticated_at_tampering();

comment on function private.prevent_last_authenticated_at_tampering is
  'Blocks any client-originated change to profiles.last_authenticated_at - '
  'the 30-day forced-reauthentication clock (docs/architecture.md sec 19.2) '
  'is only ever advanced by app/auth/callback/route.ts via the service-role '
  'client, right after a real exchangeCodeForSession. Without this trigger, '
  'the ordinary "users can update own profile" RLS policy would let any '
  'authenticated user re-stamp their own row on a timer from client-side '

-- ===================================================================
-- Source: migrations/0017_printer_profile_description_icon_and_binding_side.sql
-- ===================================================================
-- Printio: printer_profiles.description/icon_key (admin-facing profile
-- presentation, so a user picks a profile by what it *does* rather than a
-- cryptic internal label - see PrintersPanel.tsx / PrintForm.tsx), and
-- RTL-aware booklet binding side ("left edge binding" / "right edge
-- binding" - matching the Kyocera KX driver's own booklet Layout-tab
-- terminology for this printer family, see docs/printer-setup.md and
-- docs/architecture.md sec 8). apps/web/lib/pdf/imposition.ts's
-- `bindingSide` parameter is what actually acts on this.

-- ============================================================================
-- printer_profiles: description + icon_key (student/staff-facing profile picker)
-- ============================================================================
alter table printer_profiles add column description text;

comment on column printer_profiles.description is
  'Short admin-written blurb shown to a user picking a profile in the print '
  'form (e.g. "Black & white, double-sided - everyday documents"). Nullable '
  '- a profile with no description just shows its existing label alone.';

-- Curated allow-list only (never free text) - a profile can only ever
-- reference one of these known-safe lucide-react icon names, each verified
-- to actually exist in the installed lucide-react@0.469.0 package.
-- apps/web/lib/printer-profile-icons.ts is the single source of truth the UI
-- reads this same list from (keep both in sync if this list ever changes).
-- This app deliberately never uses emoji anywhere (an earlier round replaced
-- every emoji status indicator with lucide-react) - this CHECK is what keeps
-- that convention enforceable at the database level, not just a UI
-- convention a direct insert could bypass.
alter table printer_profiles add column icon_key text
  check (icon_key is null or icon_key in (
    'flip-vertical', -- duplex / double-sided
    'copy-plus',     -- multiple copies
    'palette',       -- color
    'book-open',     -- booklet
    'paperclip',     -- staple
    'circle-dot',    -- hole punch
    'star'           -- standard / default profile
  ));

comment on column printer_profiles.icon_key is
  'Optional lucide-react icon name shown next to this profile wherever it is '
  'presented for selection (apps/web/lib/printer-profile-icons.ts). '
  'Constrained to a small curated allow-list (never free text) so a profile '
  'can never reference an arbitrary/unsafe icon string. Null = no icon; the '
  'label/description are shown alone.';

-- ============================================================================
-- RTL-aware booklet binding side
-- ============================================================================
-- "left edge binding" (default - today's existing, unchanged imposition
-- behavior) vs "right edge binding" (mirrors the imposition so folding the
-- sheet and reading right-to-left, e.g. Hebrew, produces pages in the
-- correct order) - see apps/web/lib/pdf/imposition.ts's `bindingSide`
-- parameter and its proof-style test for the actual transform and why it's
-- correct.
alter table printer_profiles add column booklet_binding_side text not null default 'left'
  check (booklet_binding_side in ('left', 'right'));

comment on column printer_profiles.booklet_binding_side is
  'Which edge a booklet job''s pages are imposed to bind on - "left edge '
  'binding" (default, matches the Kyocera KX driver''s own Layout-tab term '
  'for LTR-read booklets - today''s existing, unchanged imposition '
  'behavior) or "right edge binding" (mirrors the imposition for RTL, e.g. '
  'Hebrew, reading order - see apps/web/lib/pdf/imposition.ts and '
  'docs/architecture.md sec 8). Only meaningful when '
  'declared_capabilities.booklet is true, but stored regardless of that flag '
  '- simpler than a conditional column, and harmless for a non-booklet '
  'profile since it is then simply never read. A per-job override is also '
  'available at print-submission time (apps/web/app/(dashboard)/print) '
  'without changing this stored default.';

alter table organization_settings add column default_booklet_binding_side text not null default 'left'
  check (default_booklet_binding_side in ('left', 'right'));

comment on column organization_settings.default_booklet_binding_side is
  'Prefills printer_profiles.booklet_binding_side when an org_admin creates '
  'a new booklet-capable profile (app/admin/printers) - does not itself '
  'affect any existing profile or in-flight job. Defaults to ''left'' (same '
  'as printer_profiles.booklet_binding_side''s own default) so an existing '
  'organization does not change behavior just because this column appeared; '
  'an org_admin whose organization reads right-to-left sets this to '
  '''right'' once from app/admin/settings, so every subsequently created '
  'booklet profile defaults to the binding side that actually matches how '
  'this organization reads, without re-flipping it by hand every time.';

-- ============================================================================
-- agents.discovered_queues (guided setup wizard, app/admin/printers/setup)
-- ============================================================================
-- Persists the full set of Windows print queues an Agent last reported at
-- heartbeat time (docs/agent-api.md POST /api/agents/heartbeat, `queues[]`),
-- independent of whether any of them are already registered as a
-- printer_profiles row. Previously that array was used ONLY to update an
-- already-registered printer_profile's printers.status
-- (app/api/agents/heartbeat/route.ts) and then discarded - there was no
-- record anywhere of "every queue this Agent can actually see", which is
-- exactly what the guided setup wizard needs to offer a real dropdown of
-- options when registering a *new* profile, rather than an admin hand-typing
-- a Windows queue name from memory (the single riskiest step in the
-- freeform-input flow - a typo means the Agent can never find that queue).
alter table agents add column discovered_queues jsonb not null default '[]';

comment on column agents.discovered_queues is
  'The full, raw list of Windows print queues this Agent reported at its '
  'most recent heartbeat (POST /api/agents/heartbeat, body.queues[]) - '
  'every queue Windows shows this Agent, not just ones already registered '
  'as a printer_profiles row. Each element mirrors what the Agent sent '
  '(windowsQueueName, and whatever of driverName/portName/status it '
  'included) plus a server-set "reportedAt" timestamp. Overwritten in full '
  'on every heartbeat that includes queues - like last_seen_at/version on '
  'this same row, this reflects only the most recent report, never an '
  'accumulating history/audit log (print_job_events is the append-only '
  'audit trail elsewhere in this schema; this is not that). A heartbeat '
  'with no queues[] at all (or an empty array) leaves this column '
  'untouched - silence is not the same as "this Agent now sees zero '
  'queues". Read by app/admin/printers/setup (the guided setup wizard''s '
  'step 3) to populate a <select> of real, Agent-discovered queue names '
  'instead of a freeform text input. RLS: no new policy needed - agents is '
  'already row-level-secured by organization_id (see '
  'supabase/migrations/0006_rls_policies.sql "org_admins can manage '
  'agents"), which covers every column on the row including this one.';


-- ===================================================================
-- Source: migrations/0019_close_anon_execute_gap_and_harden_0016_trigger.sql
-- ===================================================================
-- Two findings from a correctness/security audit of this session's own
-- work: (1) check_rate_limit/email_domain_allowed/email_domain_allowed_for_
-- magic_link were each callable by unauthenticated (anon) clients despite
-- their own comments claiming otherwise - both PUBLIC's default grant and
-- Supabase's own separate 'alter default privileges' grant to anon had to
-- be revoked explicitly (confirmed live via has_function_privilege).
-- check_rate_limit specifically was a live, unauthenticated DoS primitive:
-- anyone could pre-inflate another user's rate-limit bucket by key alone.
-- (2) 0016's trigger function was missing the `set search_path = ''`
-- hardening its sibling trigger already has.
revoke execute on function check_rate_limit(text, int, int) from public;
revoke execute on function email_domain_allowed() from public;
revoke execute on function email_domain_allowed_for_magic_link() from public;

revoke execute on function check_rate_limit(text, int, int) from anon;
revoke execute on function email_domain_allowed() from anon;
revoke execute on function email_domain_allowed_for_magic_link() from anon;

comment on function check_rate_limit is
  'Fixed-window rate limiter, DB-backed so it stays correct across Vercel''s '
  'multi-instance serverless model (an in-memory counter is not). Returns '
  'true if this call is allowed (count is now <= p_max_count within the '
  'current p_window_seconds-wide window), false if the caller should be '
  'rejected with a 429. p_key should already be fully scoped by the caller '
  '(e.g. "print_submit:<user_id>", "agent_register:<ip>") - this function '
  'does no authorization of its own, it only counts. Granted to authenticated '
  'only (explicitly revoked from public/anon - see 0019) since it has no '
  'way to verify a caller-supplied p_key actually belongs to that caller.';

create or replace function private.prevent_last_authenticated_at_tampering()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.last_authenticated_at is distinct from old.last_authenticated_at
     and coalesce(auth.role(), 'anon') <> 'service_role' then
    raise exception 'last_authenticated_at can only be changed by a service-role operation';
  end if;
  return new;
end;
$$;


-- ===================================================================
-- Source: migrations/0020_atomic_invitation_claim.sql
-- ===================================================================
-- claim_invitation_use(): atomically increments
-- organization_invitations.uses_count, only if max_uses hasn't been
-- reached yet - fixes a real race in the old read-then-write app-code
-- pattern (read uses_count, check < max_uses, write uses_count + 1 as a
-- client-computed literal) that let two concurrent redemptions of the same
-- code both pass the check and both succeed, over-admitting past max_uses.
-- Mirrors adjust_monthly_usage's identical atomic-conditional-UPDATE shape.
create or replace function claim_invitation_use(p_invitation_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_rows int;
begin
  update public.organization_invitations
  set uses_count = uses_count + 1
  where id = p_invitation_id
    and (max_uses is null or uses_count < max_uses);
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function claim_invitation_use is
  'Atomically increments organization_invitations.uses_count, only if '
  'max_uses has not been reached yet - the increment happens inside this '
  'single SQL statement (uses_count = uses_count + 1), not as a '
  'client-computed literal, so concurrent redemptions of the same code '
  'cannot both read the same stale count and both succeed. Returns true if '
  'this call claimed a use, false if already exhausted. Called only from '
  'apps/web/lib/auth/invitations.ts''s redeemInvitation(), which always '
  'runs as service-role.';

revoke execute on function claim_invitation_use(uuid) from public;
revoke execute on function claim_invitation_use(uuid) from anon;
revoke execute on function claim_invitation_use(uuid) from authenticated;


-- ===================================================================
-- Source: migrations/0022_agent_machine_info_pause_and_check_for_update.sql
-- ===================================================================
-- Everything the per-Agent detail page (app/admin/agents/[agentId]) needs
-- that the schema could not already answer. Three additive changes, none of
-- which touches an existing RLS policy: the `agents` policy above
-- ("org_admins can manage agents", keyed on organization_id) already covers
-- every column on the row including these, and remote_commands' policies are
-- keyed on organization_id, not on `command`.
--
--   1. Machine self-report columns - an Agent previously reported only its
--      package `version` and (0018) its discovered Windows queues, so an
--      admin had no way to tell WHICH physical machine a row is. All
--      nullable: an older Agent build simply doesn't send them.
--   2. A real pause switch, enforced server-side in
--      app/api/agents/jobs/claimable and .../[jobId]/claim - not a UI label.
--   3. CHECK_FOR_UPDATE joins the fixed remote-command allow-list.

alter table agents add column hostname text;
alter table agents add column os_version text;
alter table agents add column ip_addresses text[];
alter table agents add column is_git_checkout boolean;

comment on column agents.hostname is
  'The machine hostname this Agent reported at its most recent heartbeat '
  '(os.hostname()). Self-reported by the Agent, never verified by the cloud - '
  'it exists so an admin can tell which physical Windows machine a row '
  'corresponds to. Null until an Agent new enough to send it heartbeats.';

comment on column agents.os_version is
  'A human-readable OS description this Agent reported at its most recent '
  'heartbeat (e.g. "Windows_NT 10.0.19045 (x64)"), assembled from Node''s '
  'os.type()/os.release()/os.arch(). Self-reported, informational only - '
  'nothing in Printio branches on it. Null until reported.';

comment on column agents.ip_addresses is
  'The non-internal IPv4/IPv6 addresses this Agent saw on its own network '
  'interfaces at its most recent heartbeat (os.networkInterfaces(), loopback '
  'excluded). Self-reported and informational - it is what lets an admin '
  'confirm the machine really does have a leg on the printer network '
  '(docs/architecture.md sec 1). Never used for authentication or '
  'authorization of any kind. Null until reported.';

comment on column agents.is_git_checkout is
  'Whether this Agent detected that it is running from a real git checkout '
  '(a .git entry at the repository root above apps/agent) at its most recent '
  'heartbeat. Decides whether the CHECK_FOR_UPDATE remote command can '
  'actually self-update this machine or can only report back "re-run '
  'setup-agent.ps1 by hand" - see apps/agent/src/self-update.ts. Null until '
  'reported.';

alter table agents add column paused boolean not null default false;
alter table agents add column paused_at timestamptz;
alter table agents add column paused_by uuid references profiles(id);

create index agents_paused_by_idx on agents (paused_by) where paused_by is not null;

comment on column agents.paused is
  'True while an org_admin has deliberately held this Agent back from taking '
  'new print jobs. ENFORCED SERVER-SIDE, not in the UI: '
  'app/api/agents/jobs/claimable returns an empty list and '
  'app/api/agents/jobs/[jobId]/claim refuses with 409 agent_paused while '
  'this is true, so a paused Agent cannot claim work even if its own local '
  'poll loop ignored the paused flag it is handed in its heartbeat response. '
  'Jobs already claimed before the pause are deliberately left alone - they '
  'finish printing normally; pausing stops NEW work, it does not abandon '
  'work in flight. Distinct from status = ''disabled'', which revokes the '
  'credential outright.';

comment on column agents.paused_at is
  'When agents.paused was last set to true (cleared on unpause), so the '
  'admin console can say how long a queue has been held rather than just '
  'that it is held.';

comment on column agents.paused_by is
  'The org_admin who paused this Agent (cleared on unpause). The '
  'authoritative record of who did it is still the audit_logs row written by '
  'the pause action - this column exists so the detail page can name them '
  'without querying the audit log.';

alter table remote_commands drop constraint remote_commands_command_check;
alter table remote_commands add constraint remote_commands_command_check check (command in (
  'REFRESH_PRINTER_STATUS', 'CANCEL_PRINT_JOB', 'RESTART_PRINT_QUEUE',
  'RESTART_AGENT_SERVICE', 'CLEAR_AGENT_TEMP_FILES', 'CHECK_FOR_UPDATE'
));

comment on constraint remote_commands_command_check on remote_commands is
  'The fixed remote-command allow-list (docs/architecture.md sec 12), '
  'enforced at the database layer as well as in @printio/shared''s '
  'REMOTE_COMMANDS and the Agent''s own switch. CHECK_FOR_UPDATE was added '
  'in 0021: its Agent-side handler runs the exact same hardcoded git-pull / '
  'reinstall sequence apps/agent/scripts/setup-agent.ps1 already runs, in '
  'the Agent''s own checkout, with no argument ever taken from the payload - '
  'adding a command name to this list never adds a way to send an Agent an '
  'arbitrary string to execute.';


-- ===================================================================
-- Source: migrations/0024_print_jobs_is_test_print.sql
-- ===================================================================
-- An org_admin can send a one-page test print to any printer_profile in their
-- organization ("Send test print" on app/admin/printers and on the per-Agent
-- detail page). That test job deliberately goes down the SAME pipeline a real
-- submission does - real PDF preflight, a real object in the private
-- print-jobs bucket, a real print_jobs row the Agent claims, downloads and
-- prints - because a test that skipped any of those would not prove the queue
-- works. What it skips is only the parts that belong to a *person's* job:
-- policy evaluation, the approval queue, and quota.
--
-- This column is what keeps that honest everywhere else: a test print is a
-- real print job, but it is not real *user* print activity, so every place
-- that aggregates user activity (admin Reports, the platform overview, a
-- member's own activity card, "jobs today") filters it out, and neither the
-- Agent status route nor the cron sweep may consume or release quota for one
-- (it never reserved any - releasing would silently eat some *other* pending
-- job's reservation, since adjust_monthly_usage subtracts from the shared
-- monthly_usage row).
--
-- Additive and defaulted false, so every existing row is - correctly - a real
-- job. No RLS change is needed or wanted: print_jobs' existing policies are
-- keyed on organization_id/created_by, which already cover this column, and a
-- test print is created by the admin as themselves (created_by = auth.uid()),
-- not by service-role.
--
-- No index: every query that filters on this also filters organization_id
-- (indexed) and usually a created_at window, and test prints are a rounding
-- error in row count - a partial index here would be dead weight.
alter table print_jobs add column is_test_print boolean not null default false;

comment on column print_jobs.is_test_print is
  'True for an admin-issued test print (app/admin/printers'' "Send test '
  'print"), which exercises the full real pipeline - preflight, storage '
  'upload, agent claim/download/print - against a generated one-page PDF, '
  'but deliberately skips policy evaluation, approval and quota because it '
  'is not a person''s job. Excluded from every user-activity aggregation '
  '(lib/reports.ts and its page, lib/platform/overview.ts, admin/users/'
  '[userId], admin dashboard "jobs today") and from quota consume/release in '
  'app/api/agents/jobs/[jobId]/status and app/api/cron/sweep - a test print '
  'reserved nothing, so releasing for one would decrement another job''s '
  'live reservation.';

-- ============================================================================
-- 0025_approver_profile_visibility.sql
-- ============================================================================
-- An APPROVER can now see who submitted the job they are being asked to
-- approve. profiles' original select policy (see above) admits the row's owner
-- and org_admins of that person's organization only - so an `approver` (the
-- other role the approval queue is open to, per private.is_org_approver and
-- print_jobs' own select policy) could read the job but not the submitter's
-- name or email, and the queue had to render "Unknown" for the one fact an
-- approver most needs before deciding. Policies are OR-ed, so this only
-- widens, and only along an axis the same caller already has: they can
-- already read every print_job in that organization, and its stored file via
-- Storage's own org-scoped policy.

create policy "approvers can view their org's members' profiles"
on profiles for select
to authenticated
using (
  exists (
    select 1 from public.organization_members m
    where m.user_id = profiles.id
      and private.is_org_approver(m.organization_id)
  )
);


-- ============================================================================
-- 0031_explicit_table_grants.sql
-- ============================================================================
-- Printio: make Data API table grants explicit ahead of Supabase's
-- October 30, 2026 change (new tables in `public` no longer receive
-- automatic grants for the Data API / PostgREST roles).
-- Ref: https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically
--
-- Nothing breaks on the deployed database on Oct 30: existing tables keep
-- their current grants. This migration exists so that:
--   (a) fresh projects, preview branches, and `supabase db reset` runs that
--       replay these migrations after Oct 30 keep working - today every
--       public table here relies on the old implicit defaults, and a reset
--       would leave the whole app with "42501 permission denied for table";
--   (b) tables created by future migrations stay reachable via the Data API.
--
-- Shape (least privilege that matches actual usage):
--   - authenticated + service_role get select/insert/update/delete.
--     Every public table is queried through one or both of those roles from
--     apps/web (browser/server anon-key client and service-role client).
--   - anon gets NO table grants. No unauthenticated code path reads tables;
--     anon only needs function EXECUTE (already granted in 0012/0013/0014/0019).
--   - Row-level security (0006_rls_policies.sql) remains the authorization
--     layer for which rows each role can see; these grants only decide
--     whether PostgREST can reach a table at all.

-- 1. Explicit grants for every table that exists today. Idempotent and a
--    no-op on the current deployment, where these grants already exist via
--    the old defaults.
grant select, insert, update, delete
  on all tables in schema public
  to authenticated, service_role;

-- 2. Default privileges so any table created by a future migration gets the
--    same grants automatically. Default privileges attach to the role that
--    runs migrations, which is the role that creates these tables.
alter default privileges in schema public
  grant select, insert, update, delete on tables
  to authenticated, service_role;

-- If a future table should not be reachable by signed-in users at all
-- (service-role-only), that migration should revoke accordingly:
--   revoke all on table public.<table> from authenticated;

-- Source: migrations/0032_member_devices.sql
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

-- ============================================================================
-- Source: migrations/0033_print_stamp.sql
-- ============================================================================
-- Printio: user code stamp on page 1 of every printout (owner request 2026-10-22).
-- Design: docs/superpowers/specs/2026-10-20-printio-setup-design.md, Phase 3.
--
-- 1. organization_members.user_code: the short per-member code (initials + two digits, editable by an org_admin
--    on Admin > Users). NULL is allowed and means "not set": the app then generates initials + two digits from the
--    member's name, so existing members are stamped immediately without a backfill.
-- 2. organization_settings.stamp_*: the org-level controls (on/off, what it shows, strength). Default ON.
--
-- Access is unchanged: org_admins already update both tables under the RLS policies in 0006; every member of an
-- org already reads its roster and its settings. Grants are restated explicitly (CLAUDE.md / 0031) so this does not
-- depend on default privileges.

alter table organization_members
  add column if not exists user_code text
  check (user_code is null or user_code ~ '^[A-Z0-9]{1,12}$');

comment on column organization_members.user_code is
  'Short code stamped small and faint on page 1 of this member''s printouts so the owner can tell whose pile is '
  'whose. Uppercase letters and digits, 1-12 characters, unique within an organization when set. NULL = generated '
  'by the app from the member''s initials plus two digits (lib/jobs/user-code.ts).';

create unique index if not exists organization_members_user_code_uniq
  on organization_members (organization_id, user_code)
  where user_code is not null;

alter table organization_settings
  add column if not exists stamp_enabled boolean not null default true,
  add column if not exists stamp_show text not null default 'code'
    check (stamp_show in ('code', 'code_date')),
  add column if not exists stamp_strength text not null default 'light'
    check (stamp_strength in ('light', 'medium', 'strong'));

comment on column organization_settings.stamp_enabled is
  'Whether every print job gets its sender''s user code stamped on page 1. Default on.';
comment on column organization_settings.stamp_show is
  'What the stamp shows: ''code'' (user code only) or ''code_date'' (user code and the job''s creation date).';
comment on column organization_settings.stamp_strength is
  'Grey level of the stamp: light (very faint, default), medium, strong.';

grant select, insert, update, delete on public.organization_members to authenticated, service_role;
grant select, insert, update, delete on public.organization_settings to authenticated, service_role;

-- Source: migrations/0034_tighten_job_write_access.sql
-- Printio: close the member write holes on print_jobs, monthly_usage and the print-jobs bucket.
-- Review findings 1-3, verified against the live DB 2026-10-22.
-- *** DRAFT - NOT APPLIED. Apply only AFTER the matching web code (branch claude/server-side-writes) is deployed. ***
--
-- Before this migration a signed-in member, using the public anon key and their own session from the browser console, could:
--   1. INSERT/UPDATE any column of their own print_jobs rows (self-approve, forge jobs, skip policy and quota);
--   2. INSERT/UPDATE their own monthly_usage row and call adjust_monthly_usage with any amounts (reset their own quota);
--   3. read and overwrite EVERY colleague's PDF in the print-jobs bucket (the policies only checked the org folder).
--
-- After it, every write to those three things happens server-side with the service-role client (which bypasses RLS and
-- keeps its table grants from 0031), after the web app's own authorization checks (apps/web: lib/jobs/create-print-job.ts,
-- app/(dashboard)/print/actions.ts, app/admin/approvals/actions.ts, app/admin/printers/actions.ts,
-- app/admin/storage/actions.ts, app/(dashboard)/jobs/[id]/actions.ts).
--
-- Decisions:
--   - ALL authenticated write policies on print_jobs are dropped, approvers/admins included: approve, reject, "finish this
--     booklet", test prints and the manual storage cleanup all moved to the service role, so nothing needs them.
--   - SELECT policies stay (job pages, lists, realtime status). The admin DELETE policy on monthly_usage stays, and so does
--     the table-level DELETE grant it needs (the "reset usage" capability from 0006); INSERT/UPDATE are revoked.
--   - Storage: authenticated may only SELECT (read / sign) objects of jobs they own or whose organization they approve.
--     No insert/update/delete for any signed-in role. Paths outside org/<org>/jobs/<job>/ (e.g. gateway-intake/) are
--     service-role only.
--   - adjust_monthly_usage stays SECURITY INVOKER; the service role bypasses RLS, so nothing more is needed.
--   - print_job_events / approval_actions member INSERT policies are NOT touched here (review finding 21, a separate fix).
--
-- ROLLBACK: see the commented block at the bottom.

-- ============================================================================
-- print_jobs: no direct writes from signed-in roles
-- ============================================================================
drop policy if exists "members can create jobs in their own organization" on public.print_jobs;
drop policy if exists "owners can update own jobs; approvers/admins update their org's jobs" on public.print_jobs;

revoke insert, update, delete on table public.print_jobs from authenticated;
grant select on table public.print_jobs to authenticated;
grant select, insert, update, delete on table public.print_jobs to service_role;

-- ============================================================================
-- monthly_usage: read-only for members; usage changes only through adjust_monthly_usage run as service role
-- ============================================================================
drop policy if exists "users can reserve/consume their own usage row" on public.monthly_usage;
drop policy if exists "users can update their own usage row; org_admins can adjust" on public.monthly_usage;

revoke insert, update on table public.monthly_usage from authenticated;
grant select, delete on table public.monthly_usage to authenticated; -- delete is still gated by the "org_admins can reset usage" policy
grant select, insert, update, delete on table public.monthly_usage to service_role;

revoke execute on function public.adjust_monthly_usage(uuid, uuid, text, int, int, int, int, text, int, text)
  from public, anon, authenticated;
grant execute on function public.adjust_monthly_usage(uuid, uuid, text, int, int, int, int, text, int, text)
  to service_role;

-- ============================================================================
-- storage.objects (bucket print-jobs): read only your own jobs' files (or your org's, if you approve); no writes
-- ============================================================================
drop policy if exists "org members can read their org's job files" on storage.objects;
drop policy if exists "org members can upload their org's job files" on storage.objects;
drop policy if exists "org members can update their org's job files" on storage.objects;
drop policy if exists "org_admins can delete their org's job files" on storage.objects;

-- Path convention (apps/web/lib/storage.ts): org/<organizationId>/jobs/<jobId>/original.pdf | derived.pdf, so
-- storage.foldername(name) = {org, <organizationId>, jobs, <jobId>}. Segments are compared as TEXT on purpose: a uuid
-- cast on an arbitrary path segment (say gateway-intake/...) could raise an error instead of just not matching.
create policy "members read their own job files; approvers read their org's"
on storage.objects for select
to authenticated
using (
  bucket_id = 'print-jobs'
  and (storage.foldername(name))[1] = 'org'
  and (storage.foldername(name))[3] = 'jobs'
  and exists (
    select 1
    from public.print_jobs j
    where j.id::text = (storage.foldername(name))[4]
      and j.organization_id::text = (storage.foldername(name))[2]
      and (j.created_by = (select auth.uid()) or private.is_org_approver(j.organization_id))
  )
);

-- ============================================================================
-- ROLLBACK (uncomment and run to restore the previous, looser behavior). Copied from 0006 / 0007 / 0031 / 0010.
-- ============================================================================
-- -- print_jobs
-- create policy "members can create jobs in their own organization"
-- on print_jobs for insert
-- to authenticated
-- with check (
--   created_by = (select auth.uid())
--   and organization_id in (select private.user_org_ids())
-- );
--
-- create policy "owners can update own jobs; approvers/admins update their org's jobs"
-- on print_jobs for update
-- to authenticated
-- using (
--   created_by = (select auth.uid())
--   or private.is_org_approver(organization_id)
-- )
-- with check (
--   created_by = (select auth.uid())
--   or private.is_org_approver(organization_id)
-- );
-- grant select, insert, update, delete on table public.print_jobs to authenticated, service_role;
--
-- -- monthly_usage
-- create policy "users can reserve/consume their own usage row"
-- on monthly_usage for insert
-- to authenticated
-- with check (user_id = (select auth.uid()) or private.is_org_admin(organization_id));
--
-- create policy "users can update their own usage row; org_admins can adjust"
-- on monthly_usage for update
-- to authenticated
-- using (user_id = (select auth.uid()) or private.is_org_admin(organization_id))
-- with check (user_id = (select auth.uid()) or private.is_org_admin(organization_id));
-- grant select, insert, update, delete on table public.monthly_usage to authenticated, service_role;
--
-- grant execute on function public.adjust_monthly_usage(uuid, uuid, text, int, int, int, int, text, int, text)
--   to public, anon, authenticated, service_role;
--
-- -- storage.objects (print-jobs)
-- drop policy if exists "members read their own job files; approvers read their org's" on storage.objects;
--
-- create policy "org members can read their org's job files"
-- on storage.objects for select
-- to authenticated
-- using (
--   bucket_id = 'print-jobs'
--   and (storage.foldername(name))[1] = 'org'
--   and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
-- );
--
-- create policy "org members can upload their org's job files"
-- on storage.objects for insert
-- to authenticated
-- with check (
--   bucket_id = 'print-jobs'
--   and (storage.foldername(name))[1] = 'org'
--   and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
-- );
--
-- create policy "org members can update their org's job files"
-- on storage.objects for update
-- to authenticated
-- using (
--   bucket_id = 'print-jobs'
--   and (storage.foldername(name))[1] = 'org'
--   and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
-- )
-- with check (
--   bucket_id = 'print-jobs'
--   and (storage.foldername(name))[1] = 'org'
--   and (storage.foldername(name))[2]::uuid in (select private.user_org_ids())
-- );
--
-- create policy "org_admins can delete their org's job files"
-- on storage.objects for delete
-- to authenticated
-- using (
--   bucket_id = 'print-jobs'
--   and (storage.foldername(name))[1] = 'org'
--   and private.is_org_admin((storage.foldername(name))[2]::uuid)
-- );
-- Printio: retry failed prints (owner decision 2026-10-22).
--
-- 1. Transition rule: failed -> approved, the "re-queue" edge used by the owner's "Try again" button and by the
--    optional automatic retry. Mirrors packages/shared/src/job-state.ts. failed -> claimed and failed -> cancelled
--    stay legal. Everything else is exactly as in 0028 (held, etc.), with set search_path = '' kept.
--    THE WEBSITE CODE NEEDS THIS before "Try again" / automatic retry can work: without it the re-queue UPDATE is
--    rejected by the transition trigger ("illegal print_jobs status transition: failed -> approved") and the user
--    sees a plain "could not try again" message. Nothing else depends on it.
--
-- 2. organization_settings.auto_retry_failed_prints (default OFF): when ON, a print that fails is re-queued
--    automatically until print_jobs.max_attempts is reached, then stays failed with its message. The web code reads
--    this column tolerantly (missing column = OFF), so the code may be deployed before or after this migration.
--
-- Deploy order: either order is safe; apply this migration to turn the two features on.

create or replace function private.print_job_transition_allowed(from_status text, to_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case from_status
    when 'draft' then to_status in ('held', 'pending_approval', 'approved', 'denied', 'cancelled')
    when 'held' then to_status in ('pending_approval', 'approved', 'denied', 'cancelled', 'expired')
    when 'pending_approval' then to_status in ('approved', 'rejected', 'expired', 'cancelled')
    when 'approved' then to_status in ('claimed', 'expired', 'cancelled')
    when 'claimed' then to_status in ('downloading', 'approved', 'cancelled', 'failed')
    when 'downloading' then to_status in ('downloaded', 'failed', 'cancelled')
    when 'downloaded' then to_status in ('printing', 'failed', 'cancelled')
    when 'printing' then to_status in ('submitted_to_spooler', 'failed')
    when 'submitted_to_spooler' then to_status in ('completed', 'failed')
    when 'failed' then to_status in ('claimed', 'approved', 'cancelled')
    else false
  end
$$;

alter table organization_settings
  add column if not exists auto_retry_failed_prints boolean not null default false;

comment on column organization_settings.auto_retry_failed_prints is
  'When true, a failed print is re-queued automatically (failed -> approved) until print_jobs.max_attempts is reached; '
  'it then stays failed with its message. Default off: the owner presses Try again instead.';

-- Explicit grants (CLAUDE.md / 0031): admins update the setting under the existing RLS policy; the service role reads it.
grant select, insert, update, delete on public.organization_settings to authenticated, service_role;


-- ============================================================
-- Source: migrations/0036_remote_command_get_logs.sql
-- ============================================================

-- GET_LOGS joins the fixed remote-command allow-list ("Get recent logs" button on the Print server page).
--
-- The Agent's handler reads the tail of its OWN fixed log files and returns them with secrets masked; the command
-- takes no payload and no path ever travels from the cloud (apps/agent/src/log-collector.ts). Only the CHECK
-- constraint needs to learn the new name: no new table, column or function, so there are no new grants to add
-- (remote_commands keeps the policies and grants it already has).
--
-- Until this migration is applied the web app still works: issuing GET_LOGS is refused by this constraint and the
-- admin page says "not available yet" instead of failing silently. After it is applied the button works.

alter table remote_commands drop constraint remote_commands_command_check;
alter table remote_commands add constraint remote_commands_command_check check (command in (
  'REFRESH_PRINTER_STATUS', 'CANCEL_PRINT_JOB', 'RESTART_PRINT_QUEUE',
  'RESTART_AGENT_SERVICE', 'CLEAR_AGENT_TEMP_FILES', 'CHECK_FOR_UPDATE', 'GET_LOGS'
));

-- ============================================================
-- Source: migrations/0037_restrict_check_rate_limit.sql
-- ============================================================

-- Security review S1 (F3 + F11 quick win). Two independent statements, both safe to apply while the app is live.
--
-- 1. public.check_rate_limit is SECURITY DEFINER and "does no authorization of its own, it only counts" (0012). It
--    stayed executable by every signed-in account (0012 granted it to authenticated), so any member could call it with
--    ANOTHER person's key ("print_submit:<their user id>", ids are visible through the roster) and lock them out of
--    printing, or fill private.rate_limit_buckets with random keys. Only the server needs it, and the server calls it
--    with the service-role client (apps/web: create-print-job.ts, print/preview-action.ts, admin/printers/actions.ts,
--    api/agents/register/route.ts) after its own session / role / agent checks. So take EXECUTE away from everyone
--    except service_role. (anon and PUBLIC were already revoked in 0019; repeated here so this file alone is correct.)
--
--    Order of deploy does not matter: the web code uses the service-role client both before and after this runs.
--    Before it runs the grant is merely broader than needed; after it runs nothing in the app loses access.
--    (Code from BEFORE this change, if it were redeployed afterwards, would fail OPEN: its member-client call would
--    get "permission denied", log "rate limit check failed" and let the request through, i.e. no limiting, no outage.)
--
-- 2. public.adjust_monthly_usage had a role-mutable search_path (Supabase advisor function_search_path_mutable).
--    Re-created with `set search_path = ''` and every object name qualified. The ONLY schema-dependent name in the body
--    is the table monthly_usage (now public.monthly_usage); everything else is a parameter, a column, a plpgsql
--    construct (raise, get diagnostics), the SQL constructs `greatest` / `case`, or a pg_catalog type, all of which
--    resolve with an empty search_path. The row trigger monthly_usage_set_updated_at (private.set_updated_at) only
--    uses new.* and now() (pg_catalog). Otherwise the body is byte-for-byte the one restored by
--    0026_restore_adjust_monthly_usage_null_limit_branch.sql (identical to 0010). Still SECURITY INVOKER.
--    CREATE OR REPLACE keeps the function's existing ACL and owner; the grants are restated below anyway.
--
--    BEFORE APPLYING, compare the live body to 0026 once (it drifted before, see 0026):
--      select pg_get_functiondef('public.adjust_monthly_usage(uuid,uuid,text,int,int,int,int,text,int,text)'::regprocedure);
--    If it differs from 0026, do not apply statement 2 until the difference is understood.

-- 1. check_rate_limit: service_role only.
revoke execute on function public.check_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, int, int) to service_role;

-- 2. adjust_monthly_usage: fixed search_path.
create or replace function public.adjust_monthly_usage(
  p_organization_id uuid,
  p_user_id uuid,
  p_period text,
  p_pdf_pages int,
  p_printed_sides int,
  p_physical_sheets int,
  p_color_weighted int,
  p_quota_basis text,
  p_limit int, -- null = no quota configured for this scope (always allowed)
  p_mode text  -- 'reserve' | 'release' | 'consume'
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows int;
begin
  if p_mode not in ('reserve', 'release', 'consume') then
    raise exception 'invalid adjust_monthly_usage mode: %', p_mode;
  end if;

  insert into public.monthly_usage (organization_id, user_id, period)
  values (p_organization_id, p_user_id, p_period)
  on conflict (organization_id, user_id, period) do nothing;

  if p_mode = 'release' then
    update public.monthly_usage set
      reserved_pdf_pages = greatest(0, reserved_pdf_pages - p_pdf_pages),
      reserved_printed_sides = greatest(0, reserved_printed_sides - p_printed_sides),
      reserved_physical_sheets = greatest(0, reserved_physical_sheets - p_physical_sheets),
      reserved_color_weighted = greatest(0, reserved_color_weighted - p_color_weighted)
    where organization_id = p_organization_id and user_id = p_user_id and period = p_period;
    return true;
  end if;

  if p_mode = 'consume' then
    update public.monthly_usage set
      reserved_pdf_pages = greatest(0, reserved_pdf_pages - p_pdf_pages),
      reserved_printed_sides = greatest(0, reserved_printed_sides - p_printed_sides),
      reserved_physical_sheets = greatest(0, reserved_physical_sheets - p_physical_sheets),
      reserved_color_weighted = greatest(0, reserved_color_weighted - p_color_weighted),
      pdf_pages_used = pdf_pages_used + p_pdf_pages,
      printed_sides_used = printed_sides_used + p_printed_sides,
      physical_sheets_used = physical_sheets_used + p_physical_sheets,
      color_weighted_used = color_weighted_used + p_color_weighted
    where organization_id = p_organization_id and user_id = p_user_id and period = p_period;
    return true;
  end if;

  -- p_mode = 'reserve'
  if p_limit is null then
    update public.monthly_usage set
      reserved_pdf_pages = reserved_pdf_pages + p_pdf_pages,
      reserved_printed_sides = reserved_printed_sides + p_printed_sides,
      reserved_physical_sheets = reserved_physical_sheets + p_physical_sheets,
      reserved_color_weighted = reserved_color_weighted + p_color_weighted
    where organization_id = p_organization_id and user_id = p_user_id and period = p_period;
    return true;
  end if;

  update public.monthly_usage set
    reserved_pdf_pages = reserved_pdf_pages + p_pdf_pages,
    reserved_printed_sides = reserved_printed_sides + p_printed_sides,
    reserved_physical_sheets = reserved_physical_sheets + p_physical_sheets,
    reserved_color_weighted = reserved_color_weighted + p_color_weighted
  where organization_id = p_organization_id and user_id = p_user_id and period = p_period
    and (
      case p_quota_basis
        when 'pdf_pages' then pdf_pages_used + reserved_pdf_pages + p_pdf_pages
        when 'printed_sides' then printed_sides_used + reserved_printed_sides + p_printed_sides
        when 'physical_sheets' then physical_sheets_used + reserved_physical_sheets + p_physical_sheets
        when 'color_weighted' then color_weighted_used + reserved_color_weighted + p_color_weighted
        else physical_sheets_used + reserved_physical_sheets + p_physical_sheets
      end
    ) <= p_limit;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function public.adjust_monthly_usage is
  'Atomic quota reserve/release/consume - see docs/architecture.md sec 14. '
  'SECURITY INVOKER: runs as the caller, governed by monthly_usage RLS (callable by service_role only since 0034). '
  'Body identical to 0026; 0037 only adds set search_path = '''' and qualifies public.monthly_usage.';

-- Explicit grants (CLAUDE.md / 0031): service_role only, as set in 0034.
revoke execute on function public.adjust_monthly_usage(uuid, uuid, text, int, int, int, int, text, int, text)
  from public, anon, authenticated;
grant execute on function public.adjust_monthly_usage(uuid, uuid, text, int, int, int, int, text, int, text)
  to service_role;

-- 0038_backfill_device_first_printed.sql is a data-only back-fill (no schema change).

-- ===================================================================
-- Source: migrations/0039_join_policy.sql
-- ===================================================================
-- Printio: "Who can join" (security review F4).
--
-- Model (see docs/BACKLOG.md "Security: who can join"):
--   * Anyone can still get a Supabase auth account (magic link). An auth account
--     alone gives ZERO access: every org table is behind a membership-based RLS
--     policy and organization_members can only be inserted by an org admin or the
--     service role (proved by apps/web/lib/db-test/join-policy.db.test.ts).
--   * Membership is created only by (a) redeeming an invitation (service role,
--     apps/web/lib/auth/invitations.ts) or (b) THIS migration's
--     join_org_by_domain(), and only when an org admin chose
--     join_mode = 'invite_or_domain'.
--
-- Default for every existing organization: 'invite_only'. That changes nothing
-- for anyone today (nobody joined by domain before; the old allowed_domains list
-- only decided who reached the enter-a-code screen). Existing members and admins
-- are never touched by this function.
--
-- Not done on purpose: a Supabase "before user created" hook. An invited person
-- may legitimately use any email, and the hook cannot know about the invite at
-- sign-up time, so it would lock invited outsiders out. Instead unmatched
-- accounts exist but are inert, which the tests prove.
--
-- Re-runnable: every statement is idempotent.

alter table public.organizations
  add column if not exists join_mode text not null default 'invite_only',
  add column if not exists domain_join_role text not null default 'student';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_join_mode_check') then
    alter table public.organizations
      add constraint organizations_join_mode_check check (join_mode in ('invite_only', 'invite_or_domain'));
  end if;
  -- Domain joiners may only ever become staff or students, never admin/approver.
  if not exists (select 1 from pg_constraint where conname = 'organizations_domain_join_role_check') then
    alter table public.organizations
      add constraint organizations_domain_join_role_check check (domain_join_role in ('staff', 'student'));
  end if;
  -- Every entry must be a lower-case bare domain. NOT VALID: checks new/updated rows
  -- only, so a legacy odd value cannot make this migration fail or lock anyone out.
  if not exists (select 1 from pg_constraint where conname = 'organizations_allowed_domains_valid') then
    alter table public.organizations
      add constraint organizations_allowed_domains_valid check (
        cardinality(allowed_domains) = 0
        or (
          array_position(allowed_domains, null) is null
          and array_to_string(allowed_domains, ',') ~
            '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(,[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)*$'
        )
      ) not valid;
  end if;
  -- Domain mode with no domains would silently mean "nobody", so refuse it.
  if not exists (select 1 from pg_constraint where conname = 'organizations_domain_mode_needs_domains') then
    alter table public.organizations
      add constraint organizations_domain_mode_needs_domains check (
        join_mode = 'invite_only' or cardinality(allowed_domains) > 0
      );
  end if;
end $$;

comment on column public.organizations.join_mode is
  'invite_only: only invitations create members. invite_or_domain: additionally, a person whose VERIFIED sign-in email is on an allowed_domains domain (exact match, case-insensitive, no subdomains unless listed) becomes a member with domain_join_role on first sign-in. Enforced by public.join_org_by_domain().';
comment on column public.organizations.domain_join_role is
  'Role given to people who join by email domain. Only staff or student; admins/approvers are always assigned by an admin or invitation.';
comment on column public.organizations.allowed_domains is
  'Lower-case bare domains that may join automatically when join_mode = invite_or_domain. Grants nothing in invite_only mode. magic_link_requires_allowed_domain and the email_domain_allowed*() functions from 0013/0014 are superseded by join_mode and no longer used by the app.';

-- ============================================================================
-- join_org_by_domain(user): the only domain-based way to become a member.
-- Service role only. Reads the user's email from auth.users (never from a
-- client-supplied value) and requires it to be verified.
-- Returns the organization id when a NEW membership was created, else null.
-- ============================================================================
create or replace function public.join_org_by_domain(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_confirmed timestamptz;
  v_domain text;
  v_org_ids uuid[];
  v_org uuid;
  v_role text;
begin
  select lower(email), email_confirmed_at into v_email, v_confirmed
  from auth.users where id = p_user_id;
  if v_email is null or v_confirmed is null then
    return null;
  end if;

  -- Exactly one '@', non-empty local part; domain is everything after it.
  v_domain := substring(v_email from '^[^@[:space:]]+@([^@[:space:]]+)$');
  if v_domain is null then
    return null;
  end if;

  -- Anyone who has EVER had a membership row (active or disabled) is never
  -- auto-(re)added: an admin's decision to disable someone must stick.
  if exists (select 1 from public.organization_members where user_id = p_user_id) then
    return null;
  end if;

  select array_agg(o.id) into v_org_ids
  from public.organizations o
  where o.join_mode = 'invite_or_domain'
    and v_domain = any (o.allowed_domains);

  -- Ambiguous (several orgs claim the domain): do nothing; an invitation decides.
  if v_org_ids is null or cardinality(v_org_ids) <> 1 then
    return null;
  end if;
  v_org := v_org_ids[1];

  select o.domain_join_role into v_role from public.organizations o where o.id = v_org;

  insert into public.organization_members (user_id, organization_id, role, status)
  values (p_user_id, v_org, v_role, 'active')
  on conflict do nothing;

  if not found then
    return null;
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, target_type, target_id, metadata)
  values (v_org, p_user_id, 'member.joined_by_domain', 'organization', v_org,
          jsonb_build_object('role', v_role, 'domain', v_domain));

  return v_org;
end;
$$;

comment on function public.join_org_by_domain(uuid) is
  'Adds the user to the single organization whose join_mode is invite_or_domain and whose allowed_domains contains the user''s verified email domain. Service role only. Never re-adds someone who had a membership before.';

revoke all on function public.join_org_by_domain(uuid) from public, anon, authenticated;
grant execute on function public.join_org_by_domain(uuid) to service_role;

-- ===================================================================
-- Source: migrations/0040_grants_cleanup.sql
-- ===================================================================
-- Printio: least-privilege grants on public tables, sequences and functions
-- (security review F11).
--
-- Why: Supabase's default privileges gave anon AND authenticated ALL privileges
-- (including TRUNCATE, REFERENCES, TRIGGER) on every public table, and 0031 only
-- made the authenticated/service_role grants explicit. Today RLS alone stops
-- misuse (every public table has RLS on, no policy applies to anon), so this is
-- defence in depth: one future table created without RLS, or one overly broad
-- policy, must not be an open door.
--
-- What the app really needs (checked against apps/web: browser/server clients use
-- the `authenticated` role through RLS; everything else uses service_role):
--   anon              nothing at all on tables or sequences.
--   authenticated     SELECT/INSERT/UPDATE/DELETE only where an RLS policy for that command
--                     exists. Never TRUNCATE, REFERENCES, TRIGGER. No sequences.
--   service_role      unchanged (full access; it bypasses RLS by design).
--   functions         anon / authenticated need EXECUTE on no function in `public`: every
--                     rpc() the app makes uses the service-role client.
--
-- Safe to re-run: REVOKE of a privilege that is not held is a no-op. Nothing here
-- adds a privilege. Verify before/after with supabase/verify/grants_audit.sql
-- (zero rows = clean). Apply AFTER the web deploy that contains this change
-- (the new sign-in code no longer calls email_domain_allowed*).

-- 1. anon: nothing on public tables/sequences, now and for future tables.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

-- 2. authenticated: never TRUNCATE / REFERENCES / TRIGGER; no sequences
--    (the only sequence is print_jobs_number_seq, used by service-role inserts).
revoke truncate, references, trigger on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;
alter default privileges in schema public revoke all on sequences from authenticated;
alter default privileges in schema public revoke all on functions from authenticated;

-- 3. authenticated: drop write privileges that no RLS policy can ever use
--    (policy list in 0006/0033/0034; re-derived by the grants test).
revoke update, delete on public.approval_actions from authenticated;   -- policies: select, insert
revoke update, delete on public.audit_logs from authenticated;         -- immutable trail: select, insert
revoke update, delete on public.print_job_events from authenticated;   -- policies: select, insert
revoke insert, delete on public.organizations from authenticated;      -- policies: select, update
revoke insert, delete on public.profiles from authenticated;           -- rows come from the auth trigger
revoke delete on public.remote_commands from authenticated;            -- policies: select, insert, update

-- 4. Functions: nothing in `public` is for browser roles.
--    email_domain_allowed*() were the old sign-in gate (superseded by join_mode, 0039).
revoke execute on function public.email_domain_allowed() from public, anon, authenticated;
revoke execute on function public.email_domain_allowed_for_magic_link() from public, anon, authenticated;
revoke execute on all functions in schema public from anon;

-- ============================================================================
-- Source: migrations/0041_invitation_group.sql
-- ============================================================================
-- Printio: choose the group while creating an invite.
--
-- The person who redeems the invite is added to this group (apps/web/lib/auth/invitations.ts).
-- Nullable: existing invites have no group. If the group is deleted the invite keeps
-- working and simply stops adding people to a group (on delete set null).
-- A trigger makes sure the group belongs to the SAME organization as the invite;
-- redemption re-checks it in the app as well.
--
-- No new table, so no new grant is needed (the table already has its explicit grants
-- and RLS policy from 0006/0040). Re-runnable.

alter table public.organization_invitations
  add column if not exists group_id uuid references public.groups(id) on delete set null;

create index if not exists organization_invitations_group_idx on public.organization_invitations (group_id);

create or replace function public.check_invitation_group_same_org()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.group_id is not null
     and not exists (select 1 from public.groups g where g.id = new.group_id and g.organization_id = new.organization_id) then
    raise exception 'The invitation group must be in the same organization';
  end if;
  return new;
end $$;

revoke all on function public.check_invitation_group_same_org() from public, anon, authenticated;

drop trigger if exists organization_invitations_group_same_org on public.organization_invitations;
create trigger organization_invitations_group_same_org
  before insert or update of group_id, organization_id on public.organization_invitations
  for each row execute function public.check_invitation_group_same_org();

-- ===================================================================
-- Source: migrations/0042_setup_feedback.sql
-- ===================================================================
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

-- 0043_device_connection_tests.sql
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

-- 0046: weeks of Sichos In English added after the saved copy in the code (an admin's "Check for new weeks").
create table library_sie_entries (
  url text primary key check (url ~ '^https://drive[.]google[.]com/file/d/[A-Za-z0-9_-]{20,}/view$'),
  chelek text not null check (char_length(chelek) between 1 and 20),
  sefer text not null check (char_length(sefer) between 1 and 30),
  title text not null check (char_length(title) between 1 and 120),
  volume int check (volume is null or volume between 1 and 99),
  page int check (page is null or page between 1 and 5000),
  from_page int not null default 1 check (from_page between 1 and 50),
  to_page int check (to_page is null or to_page between 1 and 1000),
  page_count int check (page_count is null or page_count between 1 and 1000),
  added_at timestamptz not null default now(),
  added_by uuid references profiles (id) on delete set null
);
alter table library_sie_entries enable row level security;
create policy "members can read the SIE list" on library_sie_entries for select to authenticated using (true);
-- The default privileges (0031) also hand new tables to signed-in members; take the writes back so only the service role writes.
revoke insert, update, delete, truncate, references, trigger on public.library_sie_entries from authenticated;
revoke all on public.library_sie_entries from anon;
grant select on public.library_sie_entries to authenticated;
grant select, insert, update, delete on public.library_sie_entries to service_role;

-- ===================================================================
-- Source: migrations/0048_hot_query_indexes.sql
-- ===================================================================
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
