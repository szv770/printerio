-- Printio: per-person "early tools" switch.
--
-- The link import and the booklet builder start admin-only while they are being tested. An admin can switch them on for
-- a named person (a staff member helping test) from Admin -> Users -> that person. Off by default. Only org admins can
-- change a membership row (RLS "org_admins can update members"), so nobody can switch it on for themselves. Re-runnable.

alter table public.organization_members
  add column if not exists early_tools boolean not null default false;

comment on column public.organization_members.early_tools is
  'An org admin switched the early tools (print from a link, booklet builder) on for this person. Admins always have them. Default off.';

grant select, insert, update, delete on public.organization_members to authenticated, service_role;
