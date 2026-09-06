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
