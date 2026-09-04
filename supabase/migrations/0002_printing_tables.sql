-- PrintOS: agents, printers, printer profiles (Windows queue mapping), policies.
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
  -- Model-specific SNMP OID overrides (never hardcoded across models - see
  -- docs/architecture.md sec 9 / known-limitations.md). Null/empty = SNMP telemetry
  -- disabled for this printer; printing is unaffected either way.
  snmp_config jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index printers_org_idx on printers (organization_id);

-- Logical print profile -> Windows queue mapping. Finishing options are baked into
-- the Windows queue's driver "Printing Defaults" out-of-band (see printer-setup.md);
-- PrintOS never programs finishing options itself. windows_queue_name is only ever
-- resolved server-side/agent-side, never sent to an untrusted client - see
-- docs/architecture.md sec 9.
create table printer_profiles (
  id uuid primary key default gen_random_uuid(),
  printer_id uuid not null references printers(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete restrict,
  key text not null check (key ~ '^[a-z0-9_]+$'),
  label text not null check (char_length(label) between 1 and 200),
  windows_queue_name text not null,
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
