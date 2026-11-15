-- Printio: close the cross-school gaps found by the two-school isolation tests (docs/TENANT-ISOLATION-TESTS.md).
--
-- Each of these let an admin of School A, acting with their own school's id, point a row at a School B object:
--   1. remote_commands (HIGH): an admin could insert or re-point a command at another school's print server (agent_id), and the
--      agent poll filters by agent_id only, so that server would run it (restart, get-logs, check-for-update) and write the result
--      into a row the issuing school can read. Also printer_id was unchecked.
--   2. printer_profiles (MEDIUM): a profile could be bound to another school's agent.
--   3. organization_members (MEDIUM): an admin could enrol ANY existing user id (including a user of another school), then read
--      that person's name and email through the roster policy.
--
-- Tightening only: the website already checks (in app code) that the agent and printer belong to the school before it writes
-- (lib/remote-commands.ts, app/admin/printers/actions.ts), and both places that enrol members use the service role
-- (lib/auth/invitations.ts, app/platform/actions.ts), which bypasses these rules, so no existing flow changes. Re-runnable.

-- 1. remote_commands -------------------------------------------------------------------------------------------------------
drop policy if exists "org_admins can issue remote commands" on public.remote_commands;
create policy "org_admins can issue remote commands"
  on public.remote_commands for insert
  to authenticated
  with check (
    private.is_org_admin(organization_id)
    and issued_by = (select auth.uid())
    and exists (select 1 from public.agents a where a.id = remote_commands.agent_id and a.organization_id = remote_commands.organization_id)
    and (remote_commands.printer_id is null or exists (select 1 from public.printers p where p.id = remote_commands.printer_id and p.organization_id = remote_commands.organization_id))
  );

drop policy if exists "org_admins can cancel pending commands they issued" on public.remote_commands;
create policy "org_admins can cancel pending commands they issued"
  on public.remote_commands for update
  to authenticated
  using (private.is_org_admin(organization_id))
  with check (
    private.is_org_admin(organization_id)
    and exists (select 1 from public.agents a where a.id = remote_commands.agent_id and a.organization_id = remote_commands.organization_id)
    and (remote_commands.printer_id is null or exists (select 1 from public.printers p where p.id = remote_commands.printer_id and p.organization_id = remote_commands.organization_id))
  );

-- 2. printer_profiles: the profile's agent must belong to the same school as its printer ------------------------------------
-- (0009 had split the original "for all" policy into insert / update / delete; replace the insert and update ones.)
drop policy if exists "org_admins can insert printer profiles" on public.printer_profiles;
create policy "org_admins can insert printer profiles"
  on public.printer_profiles for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.printers p
      join public.agents a on a.organization_id = p.organization_id
      where p.id = printer_profiles.printer_id
        and a.id = printer_profiles.agent_id
        and private.is_org_admin(p.organization_id)
    )
  );

drop policy if exists "org_admins can update printer profiles" on public.printer_profiles;
create policy "org_admins can update printer profiles"
  on public.printer_profiles for update
  to authenticated
  using (exists (select 1 from public.printers p where p.id = printer_profiles.printer_id and private.is_org_admin(p.organization_id)))
  with check (
    exists (
      select 1
      from public.printers p
      join public.agents a on a.organization_id = p.organization_id
      where p.id = printer_profiles.printer_id
        and a.id = printer_profiles.agent_id
        and private.is_org_admin(p.organization_id)
    )
  );

-- 3. organization_members: nobody signed in enrols members directly; only server code (service role) does -------------------
-- Admins still read, update and remove their school's members; they just cannot insert arbitrary user ids themselves.
drop policy if exists "org_admins can manage members" on public.organization_members;
revoke insert on public.organization_members from authenticated;
