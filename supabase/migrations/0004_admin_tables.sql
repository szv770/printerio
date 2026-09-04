-- PrintOS: security-sensitive admin audit log + the remote-command allowlist.
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
