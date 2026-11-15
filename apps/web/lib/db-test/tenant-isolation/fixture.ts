import type { PGlite } from "@electric-sql/pglite";
import { createDb, type Db } from "../harness";

/**
 * TEST-ONLY fixture for the two-school isolation tests (docs/TENANT-ISOLATION-TESTS.md).
 *
 * Replays every real migration into PGlite (one replay per test file), then seeds TWO schools with a
 * row in (nearly) every table, so every "can school A see/change school B?" question has real B data
 * to leak. Nothing here touches a real database; the Supabase stubs live in ../harness.ts.
 */

export type School = "A" | "B";
export type RoleKey = "admin" | "approver" | "member";

export interface SchoolIds {
  school: School;
  org: string;
  users: Record<RoleKey, string>;
  agent: string;
  spareAgent: string;
  printer: string;
  sparePrinter: string;
  profile: string;
  spareProfile: string;
  group: string;
  policy: string;
  rule: string;
  /** Job created by the member (the approver and admin see it as approvers). */
  jobMember: string;
  /** Job created by the approver. */
  jobApprover: string;
  /** One registered device per person, keyed by owner role. */
  devices: Record<RoleKey, string>;
}

/** Deterministic, readable ids: aaaaaaaa-... are School A's, bbbbbbbb-... are School B's. */
const id = (school: School | "N", kind: number, n = 1) =>
  `${school === "A" ? "aaaaaaaa" : school === "B" ? "bbbbbbbb" : "cccccccc"}-0000-4000-8000-${String(kind * 100 + n).padStart(12, "0")}`;

function schoolIds(school: School): SchoolIds {
  return {
    school,
    org: id(school, 1),
    users: { admin: id(school, 2, 1), approver: id(school, 2, 2), member: id(school, 2, 3) },
    agent: id(school, 3, 1),
    spareAgent: id(school, 3, 2),
    printer: id(school, 4, 1),
    sparePrinter: id(school, 4, 2),
    profile: id(school, 5, 1),
    spareProfile: id(school, 5, 2),
    group: id(school, 6),
    policy: id(school, 7),
    rule: id(school, 8),
    jobMember: id(school, 9, 1),
    jobApprover: id(school, 9, 2),
    devices: { admin: id(school, 10, 1), approver: id(school, 10, 2), member: id(school, 10, 3) },
  };
}

export const IDS: Record<School, SchoolIds> = { A: schoolIds("A"), B: schoolIds("B") };
/** A signed-in user who belongs to no school at all. */
export const NOMEMBER = id("N", 1);

export type ActorName = "a_admin" | "a_approver" | "a_member" | "b_admin" | "b_member" | "nomember" | "anon";

export interface Actor {
  name: ActorName;
  role: "anon" | "authenticated" | "service_role";
  userId: string | null;
  school: School | null;
  roleKey: RoleKey | null;
  /** 3 admin, 2 approver, 1 member, 0 nobody (no membership / anon). */
  rank: number;
}

const person = (name: ActorName, school: School, roleKey: RoleKey): Actor => ({
  name,
  role: "authenticated",
  userId: IDS[school].users[roleKey],
  school,
  roleKey,
  rank: { admin: 3, approver: 2, member: 1 }[roleKey],
});

/** The seven callers every table is tested as. B admin is the strongest outsider (an admin of the OTHER school). */
export const ACTORS: Actor[] = [
  person("a_admin", "A", "admin"),
  person("a_approver", "A", "approver"),
  person("a_member", "A", "member"),
  person("b_admin", "B", "admin"),
  person("b_member", "B", "member"),
  { name: "nomember", role: "authenticated", userId: NOMEMBER, school: null, roleKey: null, rank: 0 },
  { name: "anon", role: "anon", userId: null, school: null, roleKey: null, rank: 0 },
];
export const SERVICE: Actor = { name: "anon", role: "service_role", userId: null, school: null, roleKey: null, rank: 99 };
export const actorByName = (n: ActorName) => ACTORS.find((a) => a.name === n)!;

export type Outcome =
  | { ok: true; rows: Record<string, unknown>[]; affected: number }
  | { ok: false; code: string; message: string };

export interface Fixture {
  db: Db;
  pg: PGlite;
  /** Run one statement as an actor inside a transaction that is ALWAYS rolled back (no test leaks into another). */
  run(actor: Actor, sql: string, params?: unknown[], opts?: { pre?: { sql: string; params?: unknown[] }[]; topic?: string }): Promise<Outcome>;
  /** Run several statements in ONE transaction as an actor; returns each outcome, stops at the first error. */
  runSteps(actor: Actor, steps: { sql: string; params?: unknown[] }[]): Promise<Outcome[]>;
  admin: Db["admin"];
}

export async function createFixture(): Promise<Fixture> {
  const db = await createDb();
  const pg = db.pg;
  // TEST-ONLY stub extension: real Supabase grants the browser roles table access on realtime.messages (RLS decides rows);
  // the shared harness stub does not, so without this every Realtime policy check would stop at "permission denied".
  await pg.exec(`grant select, insert on realtime.messages to authenticated`);
  await seed(db);

  async function inTxn<T>(actor: Actor, topic: string | undefined, body: () => Promise<T>): Promise<T> {
    await pg.exec("begin");
    try {
      await pg.exec(`set local role ${actor.role}`);
      await pg.query(
        `select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true), set_config('realtime.topic', $3, true)`,
        [actor.userId ?? "", actor.role, topic ?? ""],
      );
      return await body();
    } finally {
      await pg.exec("rollback");
    }
  }
  const one = async (sql: string, params?: unknown[]): Promise<Outcome> => {
    try {
      const r = await pg.query<Record<string, unknown>>(sql, params);
      return { ok: true, rows: r.rows, affected: r.affectedRows ?? r.rows.length };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // After an error the transaction is aborted; the caller's finally rolls it back.
      return { ok: false, code: err.code ?? "unknown", message: err.message ?? String(e) };
    }
  };

  return {
    db,
    pg,
    admin: db.admin,
    async run(actor, sql, params, opts) {
      await pg.exec("begin");
      try {
        // Optional setup done as the superuser BEFORE the role switch (e.g. delete a row so an insert cannot clash).
        for (const p of opts?.pre ?? []) await pg.query(p.sql, p.params);
        await pg.exec(`set local role ${actor.role}`);
        await pg.query(
          `select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true), set_config('realtime.topic', $3, true)`,
          [actor.userId ?? "", actor.role, opts?.topic ?? ""],
        );
        return await one(sql, params);
      } finally {
        await pg.exec("rollback");
      }
    },
    async runSteps(actor, steps) {
      return inTxn(actor, undefined, async () => {
        const out: Outcome[] = [];
        for (const s of steps) {
          const r = await one(s.sql, s.params);
          out.push(r);
          if (!r.ok) break;
        }
        return out;
      });
    },
  };
}

async function seed(db: Db) {
  const q = db.admin;
  for (const s of ["A", "B"] as School[]) {
    const I = IDS[s];
    const lc = s.toLowerCase();
    await q(`insert into organizations (id, name, slug) values ($1, $2, $3)`, [I.org, `School ${s}`, `school-${lc}`]);
    await q(`insert into organization_settings (organization_id) values ($1)`, [I.org]);
    const roleOf: Record<RoleKey, string> = { admin: "org_admin", approver: "approver", member: "student" };
    for (const k of ["admin", "approver", "member"] as RoleKey[]) {
      await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [I.users[k], `${lc}-${k}@school-${lc}.test`]);
      await q(`insert into organization_members (user_id, organization_id, role, user_code) values ($1,$2,$3,$4)`, [
        I.users[k],
        I.org,
        roleOf[k],
        `${s}${k.slice(0, 3).toUpperCase()}`,
      ]);
    }
    await q(`insert into groups (id, organization_id, name, kind) values ($1,$2,$3,'class')`, [I.group, I.org, `Class ${s}`]);
    await q(`insert into group_members (group_id, user_id) values ($1,$2)`, [I.group, I.users.member]);
    await q(`insert into organization_invitations (organization_id, code, role, created_by, group_id) values ($1,$2,'student',$3,$4)`, [
      I.org,
      `INVITECODE${s}1`,
      I.users.admin,
      I.group,
    ]);
    await q(`insert into org_fonts (organization_id, name) values ($1,$2)`, [I.org, `Font ${s}`]);

    for (const [aid, name, code] of [
      [I.agent, `Agent ${s}`, `ENROLL${s}1`],
      [I.spareAgent, `Spare agent ${s}`, `ENROLL${s}2`],
    ]) {
      await q(
        `insert into agents (id, organization_id, name, status, device_secret_hash, enrollment_code) values ($1,$2,$3,'active',$4,$5)`,
        [aid, I.org, name, `secret-hash-${s}`, code],
      );
    }
    for (const [pid, name] of [
      [I.printer, `Printer ${s}`],
      [I.sparePrinter, `Spare printer ${s}`],
    ]) {
      await q(`insert into printers (id, organization_id, name) values ($1,$2,$3)`, [pid, I.org, name]);
    }
    await q(`insert into printer_profiles (id, printer_id, agent_id, key, label, windows_queue_name) values ($1,$2,$3,'main','Main','Queue')`, [I.profile, I.printer, I.agent]);
    await q(`insert into printer_profiles (id, printer_id, agent_id, key, label, windows_queue_name) values ($1,$2,$3,'spare','Spare','Queue2')`, [
      I.spareProfile,
      I.sparePrinter,
      I.spareAgent,
    ]);
    await q(`insert into print_policies (id, organization_id, name) values ($1,$2,$3)`, [I.policy, I.org, `Policy ${s}`]);
    await q(`insert into policy_rules (id, policy_id, action, reason_label) values ($1,$2,'allow',$3)`, [I.rule, I.policy, `Rule ${s}`]);
    await q(`insert into quotas (organization_id, scope_type, limit_value) values ($1,'organization',100)`, [I.org]);
    for (const k of ["admin", "member"] as RoleKey[]) {
      await q(`insert into monthly_usage (organization_id, user_id, period) values ($1,$2,'2026-11')`, [I.org, I.users[k]]);
    }
    for (const k of ["admin", "approver", "member"] as RoleKey[]) {
      await q(
        `insert into member_devices (id, organization_id, user_id, name, device_type, token_hash) values ($1,$2,$3,$4,'windows',$5)`,
        [I.devices[k], I.org, I.users[k], `${k} laptop ${s}`, (s === "A" ? "a" : "b").repeat(63) + (k === "admin" ? "1" : k === "approver" ? "2" : "3")],
      );
      await q(`insert into device_events (device_id, type) values ($1,'seen')`, [I.devices[k]]);
      await q(
        `insert into device_connection_tests (device_id, organization_id, user_id, control_ok, control_ms, probe_ok, probe_ms, real_ok, real_ms, verdict)
         values ($1,$2,$3,true,1,true,1,true,1,'reachable')`,
        [I.devices[k], I.org, I.users[k]],
      );
      await q(`insert into device_setup_feedback (device_id, outcome) values ($1,'ok')`, [I.devices[k]]);
      await q(`insert into device_issues (device_id, kind) values ($1,'other')`, [I.devices[k]]);
    }
    for (const [jid, creator] of [
      [I.jobMember, I.users.member],
      [I.jobApprover, I.users.approver],
    ]) {
      await q(
        `insert into print_jobs (id, organization_id, created_by, printer_id, printer_profile_id, original_file_path, original_file_name,
           source_pdf_pages, file_size_bytes, estimated_printed_sides, estimated_physical_sheets)
         values ($1,$2,$3,$4,$5,$6,'doc.pdf',1,1000,1,1)`,
        [jid, I.org, creator, I.printer, I.profile, `org/${I.org}/jobs/${jid}/original.pdf`],
      );
      await q(`insert into print_job_events (job_id, event_type, actor_type, actor_id) values ($1,'JOB_CREATED','user',$2)`, [jid, creator]);
    }
    await q(`insert into approval_actions (job_id, approver_id, decision) values ($1,$2,'approved')`, [I.jobMember, I.users.approver]);
    await q(`insert into setup_confirmations (organization_id, setup_key, confirmed_by) values ($1,'android_bare_host',$2)`, [I.org, I.users.admin]);
    await q(`insert into remote_commands (organization_id, agent_id, printer_id, command, issued_by) values ($1,$2,$3,'REFRESH_PRINTER_STATUS',$4)`, [
      I.org,
      I.agent,
      I.printer,
      I.users.admin,
    ]);
    await q(`insert into audit_logs (organization_id, actor_id, action, target_type, target_id) values ($1::uuid,$2,'test.seed','organization',$1::uuid)`, [I.org, I.users.admin]);
  }
  // A signed-in user with no school, and a platform-level audit row (organization_id null: only a super_admin may read it).
  await q(`insert into auth.users (id, email, email_confirmed_at) values ($1,'nobody@nowhere.test', now())`, [NOMEMBER]);
  await q(`insert into audit_logs (organization_id, actor_id, action) values (null, $1, 'platform.seed')`, [NOMEMBER]);
  // Shared library tables: one row each, readable by every signed-in user, writable by the service role only.
  await q(
    `insert into library_daily_texts (study, study_date, portion, sections, source_url)
     values ('chumash','2026-11-15','Seed portion','[]','https://www.chabad.org/dailystudy/seed')`,
  );
  await q(
    `insert into library_sie_entries (url, chelek, sefer, title, from_page)
     values ('https://drive.google.com/file/d/AAAAAAAAAAAAAAAAAAAAAAAA/view','1','Seed','Seed title',1)`,
  );
}
