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
