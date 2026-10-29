-- Printio: what the printer itself says (shown to people whose job is waiting).
--
-- The print agent asks each direct-port printer for its status (the printer's own answer to the standard PJL status
-- question) and reports it with its heartbeat. These two columns hold the printer's last message ("Add paper in
-- cassette 2") and its status code. Display only: nothing about who may print or what happens to a job depends on them.
-- Re-runnable.

alter table public.printers
  add column if not exists status_detail text check (status_detail is null or char_length(status_detail) <= 200),
  add column if not exists status_code integer check (status_code is null or status_code between 0 and 99999);

comment on column public.printers.status_detail is 'The printer''s own last status message (e.g. "Add paper in cassette 2"), as reported by the print agent. Display only.';
comment on column public.printers.status_code is 'The printer''s PJL status code (10xxx ready/processing, 3xxxx warning, 4xxxx needs attention, 5xxxx hardware error). Display only.';
