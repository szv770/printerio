-- Printio: persist the full set of Windows print queues an Agent last
-- reported at heartbeat time (docs/agent-api.md POST /api/agents/heartbeat,
-- `queues[]`), independent of whether any of them are already registered as
-- a printer_profiles row. Today that array is used ONLY to update an
-- already-registered printer_profile's printers.status
-- (app/api/agents/heartbeat/route.ts) and then discarded - there is no
-- record anywhere of "every queue this Agent can actually see", which is
-- exactly what the guided setup wizard (app/admin/printers/setup) needs to
-- offer a real dropdown of options when registering a *new* profile, rather
-- than an admin hand-typing a Windows queue name from memory (the single
-- riskiest step in today's flow - a typo here means the Agent can never
-- find that queue).

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
