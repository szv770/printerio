-- Printio: let an org's own admins bypass approval-required/deny policy
-- outcomes and quota blocking by default (they can still see the same policy
-- reasons as a warning; the job just isn't held up by them) - an org_admin
-- submitting their own print job should almost never be hard-blocked, since
-- there's often no one else around to approve it. An org can turn this off
-- deliberately if it wants its own admins held to the same rules as everyone
-- else.
alter table organization_settings
  add column admins_bypass_restrictions boolean not null default true;

-- Audit trail: distinguishes "this job was approved because policy said so"
-- from "this job was approved only because the admin-bypass kicked in" - the
-- job detail page uses this to show a clear warning banner rather than
-- silently overriding what the org's own policy rules said.
alter table print_jobs
  add column policy_bypassed_for_admin boolean not null default false;
