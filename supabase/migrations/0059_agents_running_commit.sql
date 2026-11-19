-- Printio: the git commit a print server is actually RUNNING (hardening of the admin "Update this server" button).
-- Until now "update done" only meant "a heartbeat arrived after the command"; the website never learned which code
-- the server runs, so a restart on old code or a rollback could look like success. The Agent reads `git rev-parse HEAD`
-- once at start and sends it with its heartbeat; the website stores it here (best effort, display and the "did the
-- update really take" check only; never used for authorization).
-- Re-runnable. No new table, so no grants. Nothing here is applied until the owner applies it.

alter table public.agents add column if not exists running_commit text;

comment on column public.agents.running_commit is
  'Full git commit hash this Agent process was started from (git rev-parse HEAD at process start), as self-reported in its heartbeat. Null for an older Agent, a machine without git, or before it first reports. Display only.';
