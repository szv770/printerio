-- PrintOS: print jobs, audit trail, approvals, monthly usage.
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
