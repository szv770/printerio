-- Printio: an admin can set how often a print server (Agent) asks the website for work, without editing a file on the PC.
-- Null means "use the PC's own setting" (PRINTIO_POLL_INTERVAL_SECONDS, default 3). The heartbeat hands the value back to
-- the Agent. The range matches the Agent's own floor (2s) and a sensible ceiling (5 min). Re-runnable.
alter table public.agents
  add column if not exists poll_interval_seconds integer
  check (poll_interval_seconds is null or (poll_interval_seconds between 2 and 300));

comment on column public.agents.poll_interval_seconds is 'Admin-chosen seconds between Agent polls (2-300), or null to use the Agent''s own setting.';
