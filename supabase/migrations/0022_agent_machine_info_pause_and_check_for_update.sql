-- Printio: everything the new per-Agent detail page (app/admin/agents/[agentId])
-- needs that the schema could not already answer.
--
-- Three independent, additive changes, none of which touches an existing RLS
-- policy (the `agents` row-level policy from 0006_rls_policies.sql -
-- "org_admins can manage agents", keyed on organization_id - already covers
-- every column on the row, including the ones added here; likewise
-- remote_commands' policies are keyed on organization_id, not on `command`):
--
--   1. Machine self-report columns. Until now an Agent reported only its
--      package `version` and (0018) its discovered Windows queues, so an
--      admin looking at the Agents list had no way to tell WHICH physical
--      machine a row corresponds to - not its hostname, not its Windows
--      version, not its address on the printer network. All nullable: an
--      Agent running an older build simply doesn't send them and the columns
--      stay null (rendered as "not reported yet"), never a wrong value.
--
--   2. A real pause switch. `paused` is enforced server-side in
--      app/api/agents/jobs/claimable (a paused Agent is handed an empty job
--      list) and app/api/agents/jobs/[jobId]/claim (a paused Agent's claim is
--      refused with 409 agent_paused) - not merely a UI label, and not
--      something a modified/older Agent build can talk its way past, since
--      the enforcement is in the cloud route the Agent must call. The Agent
--      is also TOLD it is paused in its heartbeat response so it stops
--      polling for work client-side, but that is defense in depth on top of
--      the server-side refusal, never the mechanism itself.
--      Deliberately distinct from `status = 'disabled'`: disabling revokes an
--      Agent's credential entirely (it can no longer authenticate at all, so
--      it also cannot heartbeat, and the machine drops off the dashboard);
--      pausing keeps the Agent authenticated, heartbeating, and visible -
--      it just stops taking new work, which is what "we're changing the
--      toner, hold the queue" actually means.
--
--   3. CHECK_FOR_UPDATE joins the fixed remote-command allow-list. The
--      CHECK constraint is dropped and recreated with exactly one additional
--      literal - the allow-list stays a closed set of fixed command names
--      (docs/architecture.md sec 12), and there is still no code path
--      anywhere that accepts an arbitrary command string.

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
