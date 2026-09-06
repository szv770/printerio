-- PrintOS: enforce organizations.allowed_domains as an actual sign-in gate,
-- and add profiles.last_authenticated_at to support forcing a full
-- interactive re-authentication at least every 30 days, independent of
-- Supabase's own refresh-token lifetime. See docs/architecture.md sec 19 for
-- the full design rationale (this migration adds that section; the previous
-- sec 19 "What this system does not guarantee" is renumbered to sec 20).
--
-- Why this doesn't contradict sec 2.2's "no auto-admin-by-domain" rule: that
-- rule is about *authorization* - nothing about a Google OAuth login can, by
-- itself, imply an organization_id or role. This migration adds a gate on
-- whether sign-in is allowed to *proceed* at all for a brand-new user, which
-- is a different, narrower thing: passing the gate grants no
-- organization_members row, no role, nothing - it only decides whether the
-- user reaches the existing enrollment-code flow (app/no-access) instead of
-- being signed back out immediately. Actual admission remains, unconditionally,
-- the organization_invitations flow.

-- ============================================================================
-- 30-day forced re-authentication
-- ============================================================================
-- Checked independently of Supabase's own token expiry, in
-- apps/web/lib/auth/session.ts's getCurrentSession() on every session load
-- (apps/web/lib/auth/reauth.ts holds the pure isReauthRequired() check).
alter table profiles add column last_authenticated_at timestamptz;

-- Backfill so existing users aren't immediately force-logged-out the moment
-- this migration ships - a null timestamp reads as "expired" (fail closed,
-- see lib/auth/reauth.ts), so every current profile is treated as freshly
-- authenticated as of this migration; the 30-day clock starts now for
-- everyone, not retroactively from whenever they actually last signed in.
update profiles set last_authenticated_at = now() where last_authenticated_at is null;

comment on column profiles.last_authenticated_at is
  'Set to now() only by a real interactive OAuth code exchange '
  '(apps/web/app/auth/callback/route.ts) - never by the silent background '
  'token refresh that runs on every request (proxy.ts / '
  'lib/supabase/middleware.ts only calls auth.getUser(), never '
  'exchangeCodeForSession). getCurrentSession() signs the user out and '
  'redirects to /login?reason=reauth_required once this is more than 30 '
  'days old, regardless of how fresh the refresh token itself still is - '
  'see docs/architecture.md sec 19.';

-- ============================================================================
-- allowed_domains: from UX hint to an enforced (but narrow) sign-in gate
-- ============================================================================
-- Supersedes the 0001_core_tables.sql column comment ("UX hint only ... never
-- grants membership or role"). That specific invariant about membership/role
-- still holds byte-for-byte - email_domain_allowed() below returns a boolean
-- and nothing else - but the column is no longer read only to prefill a UI
-- hint; it is now actually enforced for brand-new sign-ins.
comment on column organizations.allowed_domains is
  'Enforced sign-in gate for a user with no existing active '
  'organization_members row (see apps/web/app/auth/callback/route.ts and '
  'email_domain_allowed() below). Empty array (the default) means '
  'unrestricted - any domain may attempt to join. Never grants membership or '
  'role by itself: actual admission is always the organization_invitations '
  'flow (docs/architecture.md sec 2.2). Editable by an org_admin via '
  'app/admin/settings.';

-- Callable by the signed-in user's own client (never service-role - see
-- docs/architecture.md's RLS invariants), even before that user has any
-- organization_members row and so cannot SELECT organizations directly (the
-- "members can view their organizations" policy requires membership).
-- SECURITY DEFINER, and deliberately in the public schema like
-- check_rate_limit (not private.*) so PostgREST exposes it for
-- supabase.rpc() from the callback route. Takes no arguments - it reads the
-- caller's own auth.uid()/email server-side rather than trusting a
-- client-supplied email, per this repo's "never trust client-supplied
-- identity" rule (docs/architecture.md sec 3.2). Returns only a boolean,
-- never row data, so it cannot be used to enumerate other organizations'
-- domains.
create or replace function email_domain_allowed()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_domain text;
begin
  -- Existing members are never gated by domain on sign-in - an admin may
  -- have deliberately invited an exception, or allowed_domains may have been
  -- tightened after this person already joined. Domain-check gates *new*
  -- joins only, never silently locks out an existing member.
  if exists (
    select 1 from public.organization_members
    where user_id = auth.uid() and status = 'active'
  ) then
    return true;
  end if;

  select email into v_email from auth.users where id = auth.uid();
  v_domain := lower(split_part(coalesce(v_email, ''), '@', 2));
  if v_domain = '' then
    return false;
  end if;

  -- No organization exists yet: this is the PRINTOS_BOOTSTRAP_ADMIN_EMAIL
  -- first-sign-in path (apps/web/lib/auth/bootstrap.ts) - allowed_domains
  -- doesn't exist to check against yet, so this must not block it.
  if not exists (select 1 from public.organizations) then
    return true;
  end if;

  -- Otherwise: allowed if ANY organization either has not configured a
  -- restriction (empty array - the schema default, meaning "not yet
  -- configured by an admin") or explicitly lists this domain. This only
  -- decides whether the user reaches the enrollment-code screen
  -- (app/no-access) - it grants no membership or role.
  return exists (
    select 1 from public.organizations o
    where o.allowed_domains = '{}' or v_domain = any(o.allowed_domains)
  );
end;
$$;

comment on function email_domain_allowed is
  'Sign-in domain gate for brand-new users (see '
  'apps/web/app/auth/callback/route.ts). Always true for anyone with an '
  'existing active organization_members row. Grants no organization_id or '
  'role by itself - see docs/architecture.md sec 19.';

-- Callable by any authenticated user checking their own sign-in eligibility.
-- Not granted to anon - exchangeCodeForSession must succeed (an authenticated
-- session must exist) before this is ever called.
grant execute on function email_domain_allowed() to authenticated;
