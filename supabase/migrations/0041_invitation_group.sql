-- Printio: choose the group while creating an invite.
--
-- The person who redeems the invite is added to this group (apps/web/lib/auth/invitations.ts).
-- Nullable: existing invites have no group. If the group is deleted the invite keeps
-- working and simply stops adding people to a group (on delete set null).
-- A trigger makes sure the group belongs to the SAME organization as the invite;
-- redemption re-checks it in the app as well.
--
-- No new table, so no new grant is needed (the table already has its explicit grants
-- and RLS policy from 0006/0040). Re-runnable.

alter table public.organization_invitations
  add column if not exists group_id uuid references public.groups(id) on delete set null;

create index if not exists organization_invitations_group_idx on public.organization_invitations (group_id);

create or replace function public.check_invitation_group_same_org()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.group_id is not null
     and not exists (select 1 from public.groups g where g.id = new.group_id and g.organization_id = new.organization_id) then
    raise exception 'The invitation group must be in the same organization';
  end if;
  return new;
end $$;

revoke all on function public.check_invitation_group_same_org() from public, anon, authenticated;

drop trigger if exists organization_invitations_group_same_org on public.organization_invitations;
create trigger organization_invitations_group_same_org
  before insert or update of group_id, organization_id on public.organization_invitations
  for each row execute function public.check_invitation_group_same_org();
