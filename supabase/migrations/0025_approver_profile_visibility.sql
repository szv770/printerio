-- Printio: let an APPROVER see who submitted the job they are being asked to
-- approve.
--
-- (Applied live under the name `0024_approver_profile_visibility`, then
-- renumbered to 0025 here because a concurrent change took 0024 on the dev
-- branch - same situation, and same resolution, as 0023 vs. its own applied
-- name. The SQL below is byte-for-byte what was applied.)
--
-- profiles' existing select policy (0006_rls_policies.sql) admits the row's
-- owner and org_admins of that person's organization - nobody else. An
-- `approver` (the other role the approval queue is open to, per
-- private.is_org_approver and print_jobs' own select policy) therefore could
-- read the job but not the submitter's name or email, so the approval queue
-- had to show "Unknown" for the one fact an approver most needs before
-- deciding: whose job this is.
--
-- Policies are OR-ed, so this only widens, and only along an axis the same
-- caller already has: they can already read every print_job in that
-- organization (including its file, via Storage's own org-scoped policy in
-- 0007_storage.sql). It reuses private.is_org_approver rather than a new
-- helper or an inline join, exactly like the print_jobs/print_job_events/
-- approval_actions policies do (docs/architecture.md sec 3.1).
create policy "approvers can view their org's members' profiles"
on profiles for select
to authenticated
using (
  exists (
    select 1 from public.organization_members m
    where m.user_id = profiles.id
      and private.is_org_approver(m.organization_id)
  )
);
