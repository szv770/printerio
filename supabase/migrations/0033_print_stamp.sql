-- Printio: user code stamp on page 1 of every printout (owner request 2026-10-22).
-- Design: docs/superpowers/specs/2026-10-20-printio-setup-design.md, Phase 3.
--
-- 1. organization_members.user_code: the short per-member code (initials + two digits, editable by an org_admin
--    on Admin > Users). NULL is allowed and means "not set": the app then generates initials + two digits from the
--    member's name, so existing members are stamped immediately without a backfill.
-- 2. organization_settings.stamp_*: the org-level controls (on/off, what it shows, strength). Default ON.
--
-- Access is unchanged: org_admins already update both tables under the RLS policies in 0006; every member of an
-- org already reads its roster and its settings. Grants are restated explicitly (CLAUDE.md / 0031) so this does not
-- depend on default privileges.

alter table organization_members
  add column if not exists user_code text
  check (user_code is null or user_code ~ '^[A-Z0-9]{1,12}$');

comment on column organization_members.user_code is
  'Short code stamped small and faint on page 1 of this member''s printouts so the owner can tell whose pile is '
  'whose. Uppercase letters and digits, 1-12 characters, unique within an organization when set. NULL = generated '
  'by the app from the member''s initials plus two digits (lib/jobs/user-code.ts).';

create unique index if not exists organization_members_user_code_uniq
  on organization_members (organization_id, user_code)
  where user_code is not null;

alter table organization_settings
  add column if not exists stamp_enabled boolean not null default true,
  add column if not exists stamp_show text not null default 'code'
    check (stamp_show in ('code', 'code_date')),
  add column if not exists stamp_strength text not null default 'light'
    check (stamp_strength in ('light', 'medium', 'strong'));

comment on column organization_settings.stamp_enabled is
  'Whether every print job gets its sender''s user code stamped on page 1. Default on.';
comment on column organization_settings.stamp_show is
  'What the stamp shows: ''code'' (user code only) or ''code_date'' (user code and the job''s creation date).';
comment on column organization_settings.stamp_strength is
  'Grey level of the stamp: light (very faint, default), medium, strong.';

grant select, insert, update, delete on public.organization_members to authenticated, service_role;
grant select, insert, update, delete on public.organization_settings to authenticated, service_role;
