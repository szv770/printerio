-- ===================================================================
-- Fix: profiles.last_authenticated_at was updatable by any authenticated
-- client via the existing "users can update own profile" RLS policy
-- ===================================================================
-- Found by a security audit of the 0013 domain-restriction/reauth work:
-- that policy (0006_rls_policies.sql) only restricts which ROW a user can
-- touch (id = auth.uid()), not which columns. reauth.ts's header comment
-- claimed last_authenticated_at is "set to now() in exactly one place -
-- app/auth/callback/route.ts" - true of Printio/Printio's own server code,
-- but false at the database layer: any authenticated browser client could
-- call supabase.from('profiles').update({ last_authenticated_at: ... }) on
-- their own row and pass RLS exactly like the legitimate display_name
-- update in app/(dashboard)/profile/actions.ts does. That would silently
-- neutralize the entire 30-day forced-reauth control (docs/architecture.md
-- sec 19.2) - the one thing standing between a stale/stolen session and an
-- indefinitely-refreshing Supabase session, since Supabase's own refresh
-- token otherwise never expires on its own.
--
-- Fix, mirroring the exact pattern already used for platform_role
-- (private.prevent_platform_role_escalation / profiles_prevent_privilege_
-- escalation, both in 0006_rls_policies.sql): a BEFORE UPDATE trigger that
-- rejects any change to last_authenticated_at unless the calling role is
-- service_role. app/auth/callback/route.ts already performs this update via
-- createServiceRoleClient() (see docs/architecture.md sec 19.2), so the one
-- legitimate writer is unaffected; every other path (including RLS-scoped
-- client updates and any future code that forgets this constraint) is
-- rejected outright rather than relying on "nothing else happens to touch
-- this column today" as the only guarantee.
create or replace function private.prevent_last_authenticated_at_tampering()
returns trigger
language plpgsql
as $$
begin
  if new.last_authenticated_at is distinct from old.last_authenticated_at
     and coalesce(auth.role(), 'anon') <> 'service_role' then
    raise exception 'last_authenticated_at can only be changed by a service-role operation';
  end if;
  return new;
end;
$$;

create trigger profiles_prevent_last_authenticated_at_tampering
  before update on profiles
  for each row execute function private.prevent_last_authenticated_at_tampering();

comment on function private.prevent_last_authenticated_at_tampering is
  'Blocks any client-originated change to profiles.last_authenticated_at - '
  'the 30-day forced-reauthentication clock (docs/architecture.md sec 19.2) '
  'is only ever advanced by app/auth/callback/route.ts via the service-role '
  'client, right after a real exchangeCodeForSession. Without this trigger, '
  'the ordinary "users can update own profile" RLS policy would let any '
  'authenticated user re-stamp their own row on a timer from client-side '
  'JS and never be forced back through re-authentication.';
