import { IDS, NOMEMBER, type Actor, type SchoolIds } from "./fixture";

/**
 * THE EXPECTED-ACCESS TABLE. One entry per table in the `public` schema, stating who may do what.
 * The test fails closed in BOTH directions: a table that exists in the database but is missing here
 * fails ("state its expected access"), and an entry here for a table that no longer exists fails too.
 *
 * How to read an entry (all statements are about a person acting inside THEIR OWN school; reaching the
 * other school is ALWAYS denied for every table and every role, and that is asserted separately):
 *  - school : SQL (alias `t`) giving the school (organization id) a row belongs to; null = not school data.
 *  - owner  : SQL (alias `t`) giving the user a row "belongs to", used for the "own rows only" levels.
 *  - select : what an admin / approver / member sees of their own school's rows:
 *             "all" every row, "own" only rows they own, "none" nothing.
 *  - insert / update / delete : the LOWEST role allowed ("admin" | "approver" | "member"), or "none" =
 *             nobody signed in may do it (only the service role, i.e. server code, can).
 *             ownOnly: a member-level write is limited to rows the person owns.
 *  - shared : readable by every signed-in user on purpose (library tables), writable by service role only.
 *  - noAccess : signed-in users hold NO privilege at all on the table (not even SELECT): every statement, by anyone but the
 *             service role, is "permission denied" (library_fetchers).
 *  - why    : the reason, in plain words (the migration that decided it is named where useful).
 */
export type Vis = "all" | "own" | "none";
export type Level = "admin" | "approver" | "member" | "none";

export interface TableAccess {
  why: string;
  school: string | null;
  owner?: string;
  shared?: boolean;
  noAccess?: boolean;
  select: { admin: Vis; approver: Vis; member: Vis };
  insert: Level;
  update: Level;
  delete: Level;
  /** Member-level update/delete only touches rows the person owns (profiles, own devices). */
  ownOnly?: boolean;
  /** Extra SQLSTATEs that count as "denied" when moving a row to the other school (e.g. a trigger rejects it before the policy runs). */
  moveDenyCodes?: string[];
  /** Builds one valid row for this table aimed at `target`, as `actor` would send it from the browser. */
  makeInsert: (c: InsertCtx) => Stmt;
}

export interface Stmt {
  sql: string;
  params?: unknown[];
  /** Superuser statements run first, inside the same rolled-back transaction (e.g. remove a clashing row). */
  pre?: { sql: string; params?: unknown[] }[];
}

export interface InsertCtx {
  actor: Actor;
  /** The school the new row is aimed at (may be someone else's school: that is the attack). */
  T: SchoolIds;
}

const ALL = { admin: "all", approver: "all", member: "all" } as const;
const ADMIN_ONLY = { admin: "all", approver: "none", member: "none" } as const;
const OWN_OR_ADMIN = { admin: "all", approver: "own", member: "own" } as const;
const APPROVER_ALL_MEMBER_OWN = { admin: "all", approver: "all", member: "own" } as const;
const NOTHING = { admin: "none", approver: "none", member: "none" } as const;

const ORG = "t.organization_id";
const hex64 = `md5(random()::text) || md5(random()::text)`;
/** The user a row is "from": the actor, or (for anon) a stand-in so NOT NULL columns do not mask the real RLS answer. */
const who = (c: InsertCtx) => c.actor.userId ?? c.T.users.admin;

export const EXPECTED: Record<string, TableAccess> = {
  agents: {
    why: "Print-server records. Only the school's admins manage them (0001). NOTE the secret columns (device_secret_hash, enrollment_code) are readable by those admins: see the column test.",
    school: ORG,
    select: ADMIN_ONLY,
    insert: "admin",
    update: "admin",
    delete: "admin",
    makeInsert: ({ T }) => ({ sql: `insert into agents (organization_id, name) values ($1, 'new agent')`, params: [T.org] }),
  },
  approval_actions: {
    why: "Approve/reject decisions. Approvers record their own decision on jobs of their school; the job's creator can read them (0003 'visibility mirrors the parent job'). Never updated or deleted.",
    school: "(select j.organization_id from print_jobs j where j.id = t.job_id)",
    owner: "(select j.created_by from print_jobs j where j.id = t.job_id)",
    select: APPROVER_ALL_MEMBER_OWN,
    insert: "approver",
    update: "none",
    delete: "none",
    makeInsert: (c) => ({
      sql: `insert into approval_actions (job_id, approver_id, decision) values ($1, $2, 'approved')`,
      params: [c.T.jobMember, who(c)],
    }),
  },
  audit_logs: {
    why: "Append-only activity log: admins read and add rows for their own school; platform rows (no school) are for a platform super_admin only. Nobody can edit or delete.",
    school: ORG,
    select: ADMIN_ONLY,
    insert: "admin",
    update: "none",
    delete: "none",
    makeInsert: (c) => ({
      sql: `insert into audit_logs (organization_id, actor_id, action) values ($1, $2, 'test.insert')`,
      params: [c.T.org, who(c)],
    }),
  },
  device_connection_tests: {
    why: "Results of a member's connection check (0032+). A member reads their own; admins read the school's. Written only by the server.",
    school: ORG,
    owner: "t.user_id",
    select: OWN_OR_ADMIN,
    insert: "none",
    update: "none",
    delete: "none",
    makeInsert: (c) => ({
      sql: `insert into device_connection_tests (device_id, organization_id, user_id, control_ok, control_ms, probe_ok, probe_ms, real_ok, real_ms, verdict)
            values ($1, $2, $3, true, 1, true, 1, true, 1, 'reachable')`,
      params: [c.T.devices.member, c.T.org, who(c)],
    }),
  },
  device_events: {
    why: "Per-device event log (first seen, etc). A member reads their own devices' events; admins the school's. Written only by the server.",
    school: "(select d.organization_id from member_devices d where d.id = t.device_id)",
    owner: "(select d.user_id from member_devices d where d.id = t.device_id)",
    select: OWN_OR_ADMIN,
    insert: "none",
    update: "none",
    delete: "none",
    makeInsert: (c) => ({ sql: `insert into device_events (device_id, type) values ($1, 'x')`, params: [c.T.devices.member] }),
  },
  device_issues: {
    why: "Problems a member reports on their OWN device (0042); admins of the school read and resolve them. No deletes.",
    school: "(select d.organization_id from member_devices d where d.id = t.device_id)",
    owner: "(select d.user_id from member_devices d where d.id = t.device_id)",
    select: OWN_OR_ADMIN,
    insert: "member",
    update: "admin",
    delete: "none",
    makeInsert: (c) => ({
      sql: `insert into device_issues (device_id, kind) values ($1, 'other')`,
      // A member reports on their own device; when aimed at another school, the attacker targets that school's member device.
      params: [c.actor.school === c.T.school && c.actor.roleKey ? c.T.devices[c.actor.roleKey] : c.T.devices.member],
    }),
  },
  device_setup_feedback: {
    why: "A member's 'did setup work?' answer for their OWN device (0042); a trigger fills school/user from the device. Admins read the school's.",
    school: ORG,
    owner: "t.user_id",
    select: OWN_OR_ADMIN,
    insert: "member",
    update: "none",
    delete: "none",
    makeInsert: (c) => ({
      sql: `insert into device_setup_feedback (device_id, outcome) values ($1, 'ok')`,
      params: [c.actor.school === c.T.school && c.actor.roleKey ? c.T.devices[c.actor.roleKey] : c.T.devices.member],
      // One answer per device (unique key): clear the seeded one, as the superuser, so only the access rule decides.
      pre: [{ sql: `delete from device_setup_feedback where device_id = $1`, params: [c.actor.school === c.T.school && c.actor.roleKey ? c.T.devices[c.actor.roleKey] : c.T.devices.member] }],
    }),
  },
  group_members: {
    why: "Who is in which class/department group. Every member of the school can read; only admins change (0041).",
    school: "(select g.organization_id from groups g where g.id = t.group_id)",
    select: ALL,
    insert: "admin",
    update: "admin",
    delete: "admin",
    makeInsert: ({ T }) => ({ sql: `insert into group_members (group_id, user_id) values ($1, $2)`, params: [T.group, T.users.approver] }),
  },
  groups: {
    why: "Class/department groups. Members read their school's; admins manage.",
    school: ORG,
    select: ALL,
    insert: "admin",
    update: "admin",
    delete: "admin",
    makeInsert: ({ T }) => ({ sql: `insert into groups (organization_id, name) values ($1, 'new group')`, params: [T.org] }),
  },
  library_daily_texts: {
    why: "SHARED library: the daily-study text, the same for every school. Any signed-in user reads; ONLY the service role (the owner's server) writes, so no school can alter what others read (TARGET-ARCHITECTURE sec 5).",
    school: null,
    shared: true,
    select: ALL,
    insert: "none",
    update: "none",
    delete: "none",
    makeInsert: () => ({
      sql: `insert into library_daily_texts (study, study_date, portion, sections, source_url)
            values ('tanya', '2026-12-01', 'p', '[]', 'https://www.chabad.org/dailystudy/x')`,
    }),
  },
  library_sie_entries: {
    why: "SHARED library: the SIE booklet list. Any signed-in user reads; ONLY the service role writes.",
    school: null,
    shared: true,
    select: ALL,
    insert: "none",
    update: "none",
    delete: "none",
    makeInsert: () => ({
      sql: `insert into library_sie_entries (url, chelek, sefer, title, from_page)
            values ('https://drive.google.com/file/d/BBBBBBBBBBBBBBBBBBBBBBBB/view', '1', 's', 't', 1)`,
    }),
  },
  library_fetchers: {
    why: "The print servers the OWNER allowed to fill the shared library cache (0055). No access at all for anyone signed in: not even a school admin can read it, because a row here lets that server write what every school reads. A separate table (not a flag on agents) because school admins can update their own agents rows. Service role only; the owner registers a server by hand.",
    school: "(select a.organization_id from agents a where a.id = t.agent_id)",
    noAccess: true,
    select: NOTHING,
    insert: "none",
    update: "none",
    delete: "none",
    makeInsert: ({ T }) => ({
      sql: `insert into library_fetchers (agent_id) values ($1)`,
      params: [T.spareAgent],
      pre: [{ sql: `delete from library_fetchers where agent_id = $1`, params: [T.spareAgent] }],
    }),
  },
  library_pages: {
    why: "SHARED library: parsed library pages (Likkutei Sichos, lists, entries), the same for every school (0055). Any signed-in user reads; ONLY the service role writes (the website's complete endpoint, after validating what an owner-registered print server sent), so no school can alter what others read.",
    school: null,
    shared: true,
    select: ALL,
    insert: "none",
    update: "none",
    delete: "none",
    makeInsert: () => ({
      sql: `insert into library_pages (key, kind, payload, expires_at)
            values ('iso-test:' || md5(random()::text), 'likkutei', '{}'::jsonb, now() + interval '1 day')`,
    }),
  },
  member_devices: {
    why: "A member's registered device for the print-dialog gateway. A member sees/adds/renames/revokes their OWN; admins SEE the school's. token_hash is never readable (0032; see column test).",
    school: ORG,
    owner: "t.user_id",
    select: OWN_OR_ADMIN,
    insert: "member",
    update: "member",
    delete: "none",
    ownOnly: true,
    makeInsert: (c) => ({
      sql: `insert into member_devices (organization_id, user_id, name, device_type, token_hash) values ($1, $2, 'new device', 'other', ${hex64})`,
      params: [c.T.org, who(c)],
    }),
  },
  monthly_usage: {
    why: "Quota usage counters. A person reads their own; admins read the school's and may reset (delete). Counters are changed only by the server's adjust_monthly_usage.",
    school: ORG,
    owner: "t.user_id",
    select: OWN_OR_ADMIN,
    insert: "none",
    update: "none",
    delete: "admin",
    makeInsert: (c) => ({
      sql: `insert into monthly_usage (organization_id, user_id, period) values ($1, $2, '2026-12')`,
      params: [c.T.org, who(c)],
    }),
  },
  org_fonts: {
    why: "A school's own uploaded fonts (0052). Members read their school's; writes go through the server only.",
    school: ORG,
    select: ALL,
    insert: "none",
    update: "none",
    delete: "none",
    makeInsert: ({ T }) => ({ sql: `insert into org_fonts (organization_id, name) values ($1, 'font')`, params: [T.org] }),
  },
  organization_invitations: {
    why: "Join codes. Only a school's admins can see or manage them (a member must not be able to read the codes). Moving an invitation to another school is stopped by the same-school group trigger (0041) before the policy runs.",
    moveDenyCodes: ["P0001"],
    school: ORG,
    select: ADMIN_ONLY,
    insert: "admin",
    update: "admin",
    delete: "admin",
    makeInsert: (c) => ({
      sql: `insert into organization_invitations (organization_id, code, role, created_by) values ($1, 'C' || substr(md5(random()::text), 1, 11), 'student', $2)`,
      params: [c.T.org, who(c)],
    }),
  },
  organization_members: {
    why: "The roster. Every member sees their school's roster; admins change or remove members. Nobody signed in inserts a member: server code only (invitation claim and platform console use the service role); migration 0054 dropped the admin insert rule so an admin cannot enrol an arbitrary user id.",
    school: ORG,
    owner: "t.user_id",
    select: ALL,
    insert: "none",
    update: "admin",
    delete: "admin",
    makeInsert: ({ T }) => ({
      sql: `insert into organization_members (user_id, organization_id, role) values ($1, $2, 'student')`,
      params: [NOMEMBER, T.org],
    }),
  },
  organization_settings: {
    why: "Per-school settings (quota basis, retention...). Members read; admins change.",
    school: ORG,
    select: ALL,
    insert: "admin",
    update: "admin",
    delete: "admin",
    makeInsert: ({ T }) => ({
      sql: `insert into organization_settings (organization_id) values ($1)`,
      params: [T.org],
      // The row already exists (primary key): remove it first, as the superuser, so only the access rule decides.
      pre: [{ sql: `delete from organization_settings where organization_id = $1`, params: [T.org] }],
    }),
  },
  organizations: {
    why: "The schools themselves. A member sees only their own school; admins edit it; schools are created/deleted by the server only.",
    school: "t.id",
    select: ALL,
    insert: "none",
    update: "admin",
    delete: "none",
    makeInsert: () => ({ sql: `insert into organizations (name, slug) values ('Evil school', 'evil-school')` }),
  },
  policy_rules: {
    why: "Rules inside a print policy. Admin-only, including reading them.",
    school: "(select p.organization_id from print_policies p where p.id = t.policy_id)",
    select: ADMIN_ONLY,
    insert: "admin",
    update: "admin",
    delete: "admin",
    makeInsert: ({ T }) => ({ sql: `insert into policy_rules (policy_id, action, reason_label) values ($1, 'allow', 'r')`, params: [T.policy] }),
  },
  print_job_events: {
    why: "Timeline of a print job. Job's creator and the school's approvers/admins read it and may add user/admin events about that job; nothing is edited or deleted.",
    school: "(select j.organization_id from print_jobs j where j.id = t.job_id)",
    owner: "(select j.created_by from print_jobs j where j.id = t.job_id)",
    select: APPROVER_ALL_MEMBER_OWN,
    insert: "member",
    update: "none",
    delete: "none",
    makeInsert: (c) => ({
      sql: `insert into print_job_events (job_id, event_type, actor_type, actor_id) values ($1, 'JOB_CREATED', 'user', $2)`,
      params: [c.T.jobMember, who(c)],
    }),
  },
  print_jobs: {
    why: "Print jobs. A member sees their own; approvers and admins see the school's. Browser users can NEVER insert/update/delete: jobs are created and moved through states by server code (service role) only.",
    school: ORG,
    owner: "t.created_by",
    select: APPROVER_ALL_MEMBER_OWN,
    insert: "none",
    update: "none",
    delete: "none",
    makeInsert: (c) => ({
      sql: `insert into print_jobs (organization_id, created_by, original_file_path, original_file_name, source_pdf_pages, file_size_bytes, estimated_printed_sides, estimated_physical_sheets)
            values ($1, $2, 'org/x/jobs/y/original.pdf', 'x.pdf', 1, 10, 1, 1)`,
      params: [c.T.org, who(c)],
    }),
  },
  print_policies: {
    why: "Print policies. Admin-only, including reading them.",
    school: ORG,
    select: ADMIN_ONLY,
    insert: "admin",
    update: "admin",
    delete: "admin",
    makeInsert: ({ T }) => ({ sql: `insert into print_policies (organization_id, name) values ($1, 'p')`, params: [T.org] }),
  },
  printer_profiles: {
    why: "A printer's selectable queues/profiles. Members read their school's; admins manage.",
    school: "(select p.organization_id from printers p where p.id = t.printer_id)",
    select: ALL,
    insert: "admin",
    update: "admin",
    delete: "admin",
    makeInsert: ({ T }) => ({
      sql: `insert into printer_profiles (printer_id, agent_id, key, label, windows_queue_name) values ($1, $2, 'k' || substr(md5(random()::text),1,6), 'L', 'Q')`,
      params: [T.printer, T.agent],
    }),
  },
  printers: {
    why: "Printers. Members read their school's; admins manage.",
    school: ORG,
    select: ALL,
    insert: "admin",
    update: "admin",
    delete: "admin",
    makeInsert: ({ T }) => ({ sql: `insert into printers (organization_id, name) values ($1, 'new printer')`, params: [T.org] }),
  },
  profiles: {
    why: "One row per user (name, email). You see your own; approvers and admins also see the profiles of their school's members. You may edit only your own (and not email, platform_role or last_authenticated_at: triggers).",
    school: "(select m.organization_id from organization_members m where m.user_id = t.id limit 1)",
    owner: "t.id",
    select: { admin: "all", approver: "all", member: "own" },
    insert: "none",
    update: "member",
    delete: "none",
    ownOnly: true,
    makeInsert: () => ({ sql: `insert into profiles (id, email) values (gen_random_uuid(), 'fake@x.test')` }),
  },
  quotas: {
    why: "Quota limits. Admin-only, including reading them.",
    school: ORG,
    select: ADMIN_ONLY,
    insert: "admin",
    update: "admin",
    delete: "admin",
    makeInsert: ({ T }) => ({
      sql: `insert into quotas (organization_id, scope_type, scope_value, limit_value) values ($1, 'user', 'someone', 5)`,
      params: [T.org],
    }),
  },
  remote_commands: {
    why: "Commands an admin sends to the school's print server. Admins read, send and cancel their own school's; never deleted by users.",
    school: ORG,
    select: ADMIN_ONLY,
    insert: "admin",
    update: "admin",
    delete: "none",
    makeInsert: (c) => ({
      sql: `insert into remote_commands (organization_id, agent_id, command, issued_by) values ($1, $2, 'REFRESH_PRINTER_STATUS', $3)`,
      params: [c.T.org, c.T.agent, who(c)],
    }),
  },
  server_jobs: {
    why: "Library page requests (0055). Members of the requesting school read them (to show progress); every write is the service role's (the website queues, the registered print server claims and completes through agent-authenticated endpoints).",
    school: ORG,
    select: ALL,
    insert: "none",
    update: "none",
    delete: "none",
    makeInsert: ({ T }) => ({
      sql: `insert into server_jobs (kind, organization_id, params, dedupe_key)
            values ('library_fetch', $1, '{"kind":"likkutei","volume":1}', 'iso-test:' || md5(random()::text))`,
      params: [T.org],
    }),
  },
  setup_confirmations: {
    why: "Which device setups an admin has confirmed as working for the school (0042). Members read; admins add/remove.",
    school: ORG,
    select: ALL,
    insert: "admin",
    update: "none",
    delete: "admin",
    makeInsert: (c) => ({
      sql: `insert into setup_confirmations (organization_id, setup_key, confirmed_by) values ($1, 'windows_manual_wizard', $2)`,
      params: [c.T.org, who(c)],
    }),
  },
  user_print_preferences: {
    why: "A person's own print-page preferences (0056: 'Remember my last print choices' and the last choices). OWN ROW ONLY for everyone, admins included: nobody reads or changes another user's row, in either school; no delete (the row goes with the profile); nothing for anon.",
    school: "(select m.organization_id from organization_members m where m.user_id = t.user_id limit 1)",
    owner: "t.user_id",
    select: { admin: "own", approver: "own", member: "own" },
    insert: "member",
    update: "member",
    delete: "none",
    ownOnly: true,
    // The row is always for ONE user. Aimed at the school the actor belongs to, it is the actor's own row (replacing the seeded one so the
    // primary key cannot clash); aimed at anyone else (the other school, no school, anon) it is a row for that school's member: the attack.
    makeInsert: (c) => {
      const own = c.actor.userId !== null && Object.values(c.T.users).includes(c.actor.userId);
      const userId = own ? c.actor.userId! : c.T.users.member;
      return {
        sql: `insert into user_print_preferences (user_id) values ($1)`,
        params: [userId],
        pre: [{ sql: `delete from user_print_preferences where user_id = $1`, params: [userId] }],
      };
    },
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Reference attacks: the caller is a legitimate admin of their OWN school, writes their own school's organization_id,
// but points a foreign key at the OTHER school's object. The generic matrix cannot see these, so they are listed.
// `gap` marks a case that is a REAL, currently-open hole: it is registered with `it.fails`, so CI stays green while
// the hole exists, and turns RED the day someone fixes it (so the marker gets removed). See docs/TENANT-ISOLATION-TESTS.md.
// ---------------------------------------------------------------------------------------------------------------------
export interface Attack {
  id: string;
  /** Plain-words description of what the attacker tries. */
  what: string;
  as: "a_admin" | "a_approver" | "a_member";
  steps: { sql: string; params?: unknown[] }[];
  /** SQLSTATE codes that count as "denied" for an error (default 42501 = RLS/permission denied). */
  denyCodes?: string[];
  /** Number of leading steps that must succeed (set-up), so a later denial is a real one. */
  setup?: number;
  gap?: { severity: "High" | "Medium" | "Low"; summary: string };
}

const A = IDS.A;
const B = IDS.B;

export const ATTACKS: Attack[] = [
  // --- controls: these ARE blocked today ---------------------------------------------------------------------------
  { id: "printer_profiles insert on B's printer", what: "A admin creates a queue profile on School B's printer", as: "a_admin",
    steps: [{ sql: `insert into printer_profiles (printer_id, agent_id, key, label, windows_queue_name) values ($1,$2,'x','x','x')`, params: [B.printer, A.agent] }] },
  { id: "printer_profiles update moves profile to B's printer", what: "A admin re-points A's profile at B's printer", as: "a_admin",
    steps: [{ sql: `update printer_profiles set printer_id = $1 where id = $2`, params: [B.printer, A.profile] }] },
  { id: "policy_rules insert into B's policy", what: "A admin adds a rule to School B's print policy", as: "a_admin",
    steps: [{ sql: `insert into policy_rules (policy_id, action, reason_label) values ($1,'deny','x')`, params: [B.policy] }] },
  { id: "policy_rules update moves rule to B's policy", what: "A admin moves a rule into School B's policy", as: "a_admin",
    steps: [{ sql: `update policy_rules set policy_id = $1 where id = $2`, params: [B.policy, A.rule] }] },
  { id: "group_members insert into B's group", what: "A admin puts someone into School B's group", as: "a_admin",
    steps: [{ sql: `insert into group_members (group_id, user_id) values ($1,$2)`, params: [B.group, A.users.approver] }] },
  { id: "group_members update moves row to B's group", what: "A admin moves a membership row into School B's group", as: "a_admin",
    steps: [{ sql: `update group_members set group_id = $1 where group_id = $2`, params: [B.group, A.group] }] },
  { id: "approval_actions on B's job", what: "A approver approves/rejects School B's job", as: "a_approver",
    steps: [{ sql: `insert into approval_actions (job_id, approver_id, decision) values ($1,$2,'approved')`, params: [B.jobMember, A.users.approver] }] },
  { id: "approval_actions as someone else", what: "A approver records a decision in another approver's name", as: "a_approver",
    steps: [{ sql: `insert into approval_actions (job_id, approver_id, decision) values ($1,$2,'approved')`, params: [A.jobMember, A.users.admin] }] },
  { id: "print_job_events on B's job", what: "A member writes into School B's job timeline", as: "a_member",
    steps: [{ sql: `insert into print_job_events (job_id, event_type, actor_type, actor_id) values ($1,'JOB_CANCELLED','user',$2)`, params: [B.jobMember, A.users.member] }] },
  { id: "print_job_events forging an agent event on own job", what: "A member forges a system/agent event on their own job", as: "a_member",
    steps: [{ sql: `insert into print_job_events (job_id, event_type, actor_type, actor_id) values ($1,'JOB_COMPLETED','agent',$2)`, params: [A.jobMember, A.users.member] }] },
  { id: "device_issues on B's device", what: "A member reports an issue on School B's device", as: "a_member",
    steps: [{ sql: `insert into device_issues (device_id, kind) values ($1,'other')`, params: [B.devices.member] }] },
  { id: "device_issues on a colleague's device", what: "A member reports an issue on another School A member's device", as: "a_member",
    steps: [{ sql: `insert into device_issues (device_id, kind) values ($1,'other')`, params: [A.devices.approver] }] },
  { id: "device_setup_feedback on B's device", what: "A member answers the setup question for School B's device", as: "a_member",
    steps: [{ sql: `insert into device_setup_feedback (device_id, outcome) values ($1,'ok')`, params: [B.devices.member] }] },
  { id: "member_devices in B's school", what: "A member registers a device inside School B", as: "a_member",
    steps: [{ sql: `insert into member_devices (organization_id, user_id, name, device_type, token_hash) values ($1,$2,'d','other', md5('a')||md5('b'))`, params: [B.org, A.users.member] }] },
  { id: "member_devices for B's user", what: "A member registers a device in their own school but in School B user's name", as: "a_member",
    steps: [{ sql: `insert into member_devices (organization_id, user_id, name, device_type, token_hash) values ($1,$2,'d','other', md5('a')||md5('b'))`, params: [A.org, B.users.member] }] },
  { id: "organization_invitations with B's group", what: "A admin makes an invitation that drops people into School B's group", as: "a_admin",
    denyCodes: ["P0001", "23514", "42501"],
    steps: [{ sql: `insert into organization_invitations (organization_id, code, role, created_by, group_id) values ($1,'ZZZZZZZZZZZZ','student',$2,$3)`, params: [A.org, A.users.admin, B.group] }] },
  { id: "organization_members move into B", what: "A admin moves a School A member's membership row into School B", as: "a_admin",
    steps: [{ sql: `update organization_members set organization_id = $1 where user_id = $2`, params: [B.org, A.users.member] }] },
  { id: "audit_logs platform row", what: "A admin writes a platform-level audit row (no school)", as: "a_admin",
    steps: [{ sql: `insert into audit_logs (organization_id, actor_id, action) values (null, $1, 'forged.platform')`, params: [A.users.admin] }] },
  { id: "audit_logs in someone else's name", what: "A admin writes an audit row claiming another person did it", as: "a_admin",
    steps: [{ sql: `insert into audit_logs (organization_id, actor_id, action) values ($1,$2,'forged')`, params: [A.org, A.users.member] }] },
  { id: "remote_commands issued in someone else's name", what: "A admin sends a command recorded as issued by another admin", as: "a_admin",
    steps: [{ sql: `insert into remote_commands (organization_id, agent_id, command, issued_by) values ($1,$2,'GET_LOGS',$3)`, params: [A.org, A.agent, B.users.admin] }] },
  { id: "profiles platform_role escalation", what: "A member makes themselves a platform super_admin", as: "a_member",
    denyCodes: ["P0001", "42501"],
    steps: [{ sql: `update profiles set platform_role = 'super_admin' where id = $1`, params: [A.users.member] }] },
  { id: "profiles email change", what: "A member changes their own profile email (identity spoofing)", as: "a_member",
    denyCodes: ["P0001", "42501"],
    steps: [{ sql: `update profiles set email = 'admin@school-b.test' where id = $1`, params: [A.users.member] }] },
  { id: "profiles read of a School B user", what: "A admin reads a School B user's profile by id", as: "a_admin",
    steps: [{ sql: `select id from profiles where id = $1`, params: [B.users.member] }] },
  { id: "member_devices un-revoke", what: "A member re-enables a revoked device", as: "a_member",
    denyCodes: ["P0001", "42501"],
    setup: 1,
    steps: [
      { sql: `update member_devices set revoked_at = now() where id = $1`, params: [A.devices.member] },
      { sql: `update member_devices set revoked_at = null where id = $1`, params: [A.devices.member] },
    ] },

  // --- Fixed by migration 0054 (these were open gaps): now plain 'must be blocked' cases, so a regression turns CI red ------
  // --- STILL OPEN (marked `gap`): only the Low integrity case below -------------------------------------------------------
  { id: "remote_commands insert aimed at B's agent", what: "A admin sends a command (own organization_id) to School B's print server by its agent id", as: "a_admin",
    steps: [{ sql: `insert into remote_commands (organization_id, agent_id, command, issued_by) values ($1,$2,'GET_LOGS',$3)`, params: [A.org, B.agent, A.users.admin] }] },
  { id: "remote_commands update re-points at B's agent", what: "A admin re-points an existing A command at School B's print server", as: "a_admin",
    steps: [{ sql: `update remote_commands set agent_id = $1 where organization_id = $2`, params: [B.agent, A.org] }] },
  { id: "remote_commands references B's printer", what: "A admin sends a command naming School B's printer", as: "a_admin",
    steps: [{ sql: `insert into remote_commands (organization_id, agent_id, printer_id, command, issued_by) values ($1,$2,$3,'REFRESH_PRINTER_STATUS',$4)`, params: [A.org, A.agent, B.printer, A.users.admin] }] },
  { id: "printer_profiles bound to B's agent (insert)", what: "A admin creates a profile on A's printer that is served by School B's print server", as: "a_admin",
    steps: [{ sql: `insert into printer_profiles (printer_id, agent_id, key, label, windows_queue_name) values ($1,$2,'x2','x','x')`, params: [A.printer, B.agent] }] },
  { id: "printer_profiles update re-points at B's agent", what: "A admin re-points A's profile at School B's print server", as: "a_admin",
    steps: [{ sql: `update printer_profiles set agent_id = $1 where id = $2`, params: [B.agent, A.profile] }] },
  { id: "organization_members adds a School B user without consent", what: "A admin enrols a School B person (by id) into School A, then reads their profile", as: "a_admin",
    steps: [
      { sql: `insert into organization_members (user_id, organization_id, role) values ($1,$2,'student')`, params: [B.users.member, A.org] },
      { sql: `select id, email from profiles where id = $1`, params: [B.users.member] },
    ] },
  { id: "GAP group_members adds a School B user to A's group", what: "A admin adds a School B person (by id) to a School A group", as: "a_admin",
    gap: { severity: "Low", summary: "group_members checks only the group's school; user_id may be anyone, including someone who is not a member of that school (integrity only, no data read)." },
    steps: [{ sql: `insert into group_members (group_id, user_id) values ($1,$2)`, params: [A.group, B.users.member] }] },
];
