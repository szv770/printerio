-- Printio: the per-organization switch for "prepare PDFs on the organization's own print server"
-- (docs/PREPARE-JOBS-DESIGN.md, plan P2b). OFF by default: an organization keeps today's synchronous path until the platform owner
-- switches it on for that one organization (the owner's own school first).
--
-- Only the platform owner decides this, so an organization admin (who may edit their other settings) must not be able to flip it:
-- changes made through the app by a signed-in or anonymous user are refused; the SQL editor and the service role are allowed.
-- Re-runnable. Nothing here is applied until the owner applies it.

alter table public.organization_settings
  add column if not exists prepare_via_server boolean not null default false;

create or replace function private.protect_prepare_via_server()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.prepare_via_server is distinct from old.prepare_via_server
     and current_user in ('authenticated', 'anon') then
    raise exception 'prepare_via_server can only be changed by the platform owner';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_settings_protect_prepare_via_server on public.organization_settings;
create trigger organization_settings_protect_prepare_via_server
  before update on public.organization_settings
  for each row execute function private.protect_prepare_via_server();
