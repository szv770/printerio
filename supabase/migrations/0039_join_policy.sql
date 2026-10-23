-- Printio: "Who can join" (security review F4).
--
-- Model (see docs/BACKLOG.md "Security: who can join"):
--   * Anyone can still get a Supabase auth account (magic link). An auth account
--     alone gives ZERO access: every org table is behind a membership-based RLS
--     policy and organization_members can only be inserted by an org admin or the
--     service role (proved by apps/web/lib/db-test/join-policy.db.test.ts).
--   * Membership is created only by (a) redeeming an invitation (service role,
--     apps/web/lib/auth/invitations.ts) or (b) THIS migration's
--     join_org_by_domain(), and only when an org admin chose
--     join_mode = 'invite_or_domain'.
--
-- Default for every existing organization: 'invite_only'. That changes nothing
-- for anyone today (nobody joined by domain before; the old allowed_domains list
-- only decided who reached the enter-a-code screen). Existing members and admins
-- are never touched by this function.
--
-- Not done on purpose: a Supabase "before user created" hook. An invited person
-- may legitimately use any email, and the hook cannot know about the invite at
-- sign-up time, so it would lock invited outsiders out. Instead unmatched
-- accounts exist but are inert, which the tests prove.
--
-- Re-runnable: every statement is idempotent.

alter table public.organizations
  add column if not exists join_mode text not null default 'invite_only',
  add column if not exists domain_join_role text not null default 'student';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_join_mode_check') then
    alter table public.organizations
      add constraint organizations_join_mode_check check (join_mode in ('invite_only', 'invite_or_domain'));
  end if;
  -- Domain joiners may only ever become staff or students, never admin/approver.
  if not exists (select 1 from pg_constraint where conname = 'organizations_domain_join_role_check') then
    alter table public.organizations
      add constraint organizations_domain_join_role_check check (domain_join_role in ('staff', 'student'));
  end if;
  -- Every entry must be a lower-case bare domain. NOT VALID: checks new/updated rows
  -- only, so a legacy odd value cannot make this migration fail or lock anyone out.
  if not exists (select 1 from pg_constraint where conname = 'organizations_allowed_domains_valid') then
    alter table public.organizations
      add constraint organizations_allowed_domains_valid check (
        cardinality(allowed_domains) = 0
        or (
          array_position(allowed_domains, null) is null
          and array_to_string(allowed_domains, ',') ~
            '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(,[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)*$'
        )
      ) not valid;
  end if;
  -- Domain mode with no domains would silently mean "nobody", so refuse it.
  if not exists (select 1 from pg_constraint where conname = 'organizations_domain_mode_needs_domains') then
    alter table public.organizations
      add constraint organizations_domain_mode_needs_domains check (
        join_mode = 'invite_only' or cardinality(allowed_domains) > 0
      );
  end if;
end $$;

comment on column public.organizations.join_mode is
  'invite_only: only invitations create members. invite_or_domain: additionally, a person whose VERIFIED sign-in email is on an allowed_domains domain (exact match, case-insensitive, no subdomains unless listed) becomes a member with domain_join_role on first sign-in. Enforced by public.join_org_by_domain().';
comment on column public.organizations.domain_join_role is
  'Role given to people who join by email domain. Only staff or student; admins/approvers are always assigned by an admin or invitation.';
comment on column public.organizations.allowed_domains is
  'Lower-case bare domains that may join automatically when join_mode = invite_or_domain. Grants nothing in invite_only mode. magic_link_requires_allowed_domain and the email_domain_allowed*() functions from 0013/0014 are superseded by join_mode and no longer used by the app.';

-- ============================================================================
-- join_org_by_domain(user): the only domain-based way to become a member.
-- Service role only. Reads the user's email from auth.users (never from a
-- client-supplied value) and requires it to be verified.
-- Returns the organization id when a NEW membership was created, else null.
-- ============================================================================
create or replace function public.join_org_by_domain(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_confirmed timestamptz;
  v_domain text;
  v_org_ids uuid[];
  v_org uuid;
  v_role text;
begin
  select lower(email), email_confirmed_at into v_email, v_confirmed
  from auth.users where id = p_user_id;
  if v_email is null or v_confirmed is null then
    return null;
  end if;

  -- Exactly one '@', non-empty local part; domain is everything after it.
  v_domain := substring(v_email from '^[^@[:space:]]+@([^@[:space:]]+)$');
  if v_domain is null then
    return null;
  end if;

  -- Anyone who has EVER had a membership row (active or disabled) is never
  -- auto-(re)added: an admin's decision to disable someone must stick.
  if exists (select 1 from public.organization_members where user_id = p_user_id) then
    return null;
  end if;

  select array_agg(o.id) into v_org_ids
  from public.organizations o
  where o.join_mode = 'invite_or_domain'
    and v_domain = any (o.allowed_domains);

  -- Ambiguous (several orgs claim the domain): do nothing; an invitation decides.
  if v_org_ids is null or cardinality(v_org_ids) <> 1 then
    return null;
  end if;
  v_org := v_org_ids[1];

  select o.domain_join_role into v_role from public.organizations o where o.id = v_org;

  insert into public.organization_members (user_id, organization_id, role, status)
  values (p_user_id, v_org, v_role, 'active')
  on conflict do nothing;

  if not found then
    return null;
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, target_type, target_id, metadata)
  values (v_org, p_user_id, 'member.joined_by_domain', 'organization', v_org,
          jsonb_build_object('role', v_role, 'domain', v_domain));

  return v_org;
end;
$$;

comment on function public.join_org_by_domain(uuid) is
  'Adds the user to the single organization whose join_mode is invite_or_domain and whose allowed_domains contains the user''s verified email domain. Service role only. Never re-adds someone who had a membership before.';

revoke all on function public.join_org_by_domain(uuid) from public, anon, authenticated;
grant execute on function public.join_org_by_domain(uuid) to service_role;
