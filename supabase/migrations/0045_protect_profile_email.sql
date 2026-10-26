-- Printio security: a member must not be able to change profiles.email.
--
-- The "users can update own profile" policy lets a member update their own profiles row, and until now that included
-- the email column. The email mirrors the sign-in address (auth.users) and is what the admin roster, the approval
-- queue and the gateway's "who sent this" label show, and what "promote a super admin by email" matches on. A member
-- could therefore make their row show someone else's address. Only display_name is ever changed from the browser.
--
-- Same pattern as the platform_role (0006) and last_authenticated_at (0016) protections: reject the change unless the
-- caller is the service role. Also one profile per address (case-insensitive), so an email can never match two accounts.
-- Re-runnable.

create or replace function private.prevent_profile_email_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.email is distinct from old.email
     and coalesce(auth.role(), 'anon') <> 'service_role' then
    raise exception 'email can only be changed by a service-role operation';
  end if;
  return new;
end;
$$;

revoke execute on function private.prevent_profile_email_change() from public;
revoke execute on function private.prevent_profile_email_change() from anon;

drop trigger if exists profiles_prevent_email_change on public.profiles;
create trigger profiles_prevent_email_change
  before update on public.profiles
  for each row execute function private.prevent_profile_email_change();

create unique index if not exists profiles_email_lower_key on public.profiles (lower(email));
