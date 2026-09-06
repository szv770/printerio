-- Printio: add Supabase magic-link (email OTP) sign-in as a second sign-in
-- method alongside Google OAuth, and give an org_admin a per-organization
-- toggle over whether magic-link sign-ins are subject to the same
-- allowed_domains gate that Google OAuth sign-ins already go through
-- unconditionally. See docs/architecture.md sec 19.3 for the full design
-- rationale.
--
-- This is deliberately NOT a change to email_domain_allowed() or to Google
-- OAuth's behavior in any way - that function, and the gate it enforces, stay
-- exactly as they are today (0013_domain_restriction_and_reauth.sql), always
-- checked for a Google-OAuth-originated sign-in, with no toggle and no way to
-- turn it off. This migration only adds a second, independent function for
-- the second sign-in method, so a mistake here cannot regress the existing
-- Google gate.
--
-- Same invariant as 0013's, restated because it's the one this migration
-- must not violate either: passing this gate grants no organization_members
-- row, no role, nothing - it only decides whether exchangeCodeForSession's
-- result is allowed to stand for a brand-new user (apps/web/app/auth/
-- callback/route.ts), rather than being signed back out immediately. Actual
-- admission remains, unconditionally, the organization_invitations flow.

-- ============================================================================
-- Per-org toggle
-- ============================================================================
-- Defaults to true (the same restriction Google OAuth already enforces) so a
-- newly-created organization - and every organization that exists today,
-- before this feature shipped - does not suddenly become MORE open than it
-- was a moment ago just because this column appeared. An org_admin opts in to
-- the looser behavior explicitly, from app/admin/settings; nothing flips it
-- open by default.
alter table organizations
  add column magic_link_requires_allowed_domain boolean not null default true;

comment on column organizations.magic_link_requires_allowed_domain is
  'Whether magic-link (email OTP) sign-in for a brand-new user is subject to '
  'this organization''s allowed_domains list, the same way Google OAuth '
  'sign-in always is (see email_domain_allowed_for_magic_link() below). '
  'Defaults to true - same restriction Google OAuth already has - so this '
  'column cannot make an organization more open than it was before this '
  'feature existed unless an org_admin explicitly turns it off from '
  'app/admin/settings. Turning it off does not grant membership or role by '
  'itself, same as allowed_domains itself never has (docs/architecture.md '
  'sec 19.1) - it only widens who reaches the existing enrollment-code flow '
  '(app/no-access) via the magic-link method specifically. Has no effect on '
  'Google OAuth sign-in, which is never gated by this column.';

-- ============================================================================
-- email_domain_allowed_for_magic_link(): the magic-link sign-in gate
-- ============================================================================
-- Deliberately a separate function from email_domain_allowed() rather than a
-- parameterized version of it - the two methods' gates are independent
-- product decisions (an org_admin can loosen magic-link without touching
-- Google's gate at all), and keeping them as separate functions means a bug
-- in one cannot silently change the other's behavior.
--
-- Mirrors email_domain_allowed()'s shape exactly for the first two checks
-- (copied verbatim, not reimplemented) and only diverges for the actual
-- per-org domain check, where it additionally consults
-- magic_link_requires_allowed_domain:
--
--   - An organization with the toggle OFF unconditionally allows any domain
--     for magic-link purposes, regardless of what allowed_domains contains -
--     the toggle is specifically an override for this sign-in method, not a
--     second copy of the domain list to keep in sync.
--   - An organization with the toggle ON (the default) is checked against
--     allowed_domains exactly like email_domain_allowed() checks it today
--     (empty array = unrestricted; otherwise the domain must be listed).
--
-- Multi-org shape: this deployment is single-org today, but the OR-across-
-- organizations shape below is chosen to stay correct if a second
-- organization existed, and it deliberately mirrors the OR shape
-- email_domain_allowed() already uses (allowed if ANY organization would
-- allow it) rather than inventing a different combination rule for the same
-- kind of question: allowed if ANY organization either has the toggle off
-- (unconditional allow for that org), or has the toggle on with an
-- allowed_domains list that would allow this domain. A domain rejected by
-- every organization's magic-link policy is rejected overall - same
-- "any organization is enough to let a brand-new user reach the
-- enrollment-code screen" reasoning as the existing function, just extended
-- with one more per-org condition to check.
create or replace function email_domain_allowed_for_magic_link()
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
  -- Existing members are never gated by domain on sign-in, regardless of
  -- method - identical rationale and identical check to
  -- email_domain_allowed() (copied verbatim, not reimplemented).
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

  -- No organization exists yet: same bootstrap-path carve-out as
  -- email_domain_allowed() - allowed_domains/magic_link_requires_allowed_domain
  -- don't exist to check against yet, so this must not block
  -- PRINTIO_BOOTSTRAP_ADMIN_EMAIL's first sign-in (lib/auth/bootstrap.ts),
  -- however that first sign-in happens to arrive.
  if not exists (select 1 from public.organizations) then
    return true;
  end if;

  -- Otherwise: allowed if ANY organization either has turned the toggle off
  -- (unconditional allow for magic-link purposes, this org's allowed_domains
  -- notwithstanding) or has the toggle on and would allow this domain via the
  -- same allowed_domains logic email_domain_allowed() uses (empty array = not
  -- yet configured = unrestricted; otherwise the domain must be listed).
  -- Grants no membership or role - only decides whether this brand-new user
  -- reaches app/no-access's existing enrollment-code flow.
  return exists (
    select 1 from public.organizations o
    where o.magic_link_requires_allowed_domain = false
       or o.allowed_domains = '{}'
       or v_domain = any(o.allowed_domains)
  );
end;
$$;

comment on function email_domain_allowed_for_magic_link is
  'Sign-in domain gate for brand-new users arriving via magic-link (email '
  'OTP) sign-in specifically - see apps/web/app/auth/callback/route.ts, '
  'which branches on the detected sign-in provider to call this instead of '
  'email_domain_allowed() for a magic-link-originated session. Always true '
  'for anyone with an existing active organization_members row. Honors '
  'each organization''s magic_link_requires_allowed_domain toggle (default '
  'true = same restriction as Google OAuth); an organization with the '
  'toggle off allows any domain to reach the magic-link flow. Grants no '
  'organization_id or role by itself - see docs/architecture.md sec 19.3.';

-- Same grant shape as email_domain_allowed(): callable by any authenticated
-- user checking their own sign-in eligibility, not granted to anon -
-- exchangeCodeForSession must succeed (an authenticated session must exist)
-- before this is ever called.
grant execute on function email_domain_allowed_for_magic_link() to authenticated;
