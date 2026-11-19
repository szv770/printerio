import { describe, it, expect, beforeAll } from "vitest";
import { ACTORS, IDS, NOMEMBER, SERVICE, actorByName, createFixture, type Fixture, type Outcome } from "./fixture";

/**
 * Part 2 of the two-school isolation tests (docs/TENANT-ISOLATION-TESTS.md):
 *  - every SQL function the API could expose (EXECUTE grants, SECURITY DEFINER, fixed search_path),
 *  - columns that hold secrets (hashes, tokens, codes),
 *  - default privileges for tables/functions added in the future,
 *  - the Realtime and Storage POLICIES (logic only: see the doc for what PGlite cannot prove),
 *  - which tables are published to Realtime.
 * One migration replay for the whole file.
 */

let fx: Fixture;
beforeAll(async () => {
  fx = await createFixture();
}, 120_000);

const denied = (o: Outcome) => (o.ok ? o.affected === 0 && o.rows.length === 0 : o.code === "42501");
const show = (o: Outcome) => (o.ok ? `ok(${o.rows.length} rows, ${o.affected} affected)` : `${o.code}: ${o.message}`);

// =====================================================================================================================
// 1. FUNCTIONS
// =====================================================================================================================
/**
 * Every function in `public` (PostgREST exposes /rpc/<name> for these) and `private` (never exposed, but policies use it).
 * `exposed: "service_role"` = only the server's service role may execute it; anon and signed-in users must NOT.
 * `takesIdFromArguments` flags functions that trust an organization/user/invitation id passed in: harmless while only the
 * service role can call them (the server decides the id), but a cross-school hole the moment anyone else could.
 * Functions that belong to the pgcrypto extension are skipped: in real Supabase they live in the `extensions` schema
 * (not exposed); only the PGlite replay puts them in `public`.
 */
const FUNCTIONS: Record<string, { secdef: boolean; exposed: "service_role" | "private-schema"; takesIdFromArguments?: string; why: string }> = {
  "public.adjust_monthly_usage(p_organization_id uuid, p_user_id uuid, p_period text, p_pdf_pages integer, p_printed_sides integer, p_physical_sheets integer, p_color_weighted integer, p_quota_basis text, p_limit integer, p_mode text)": {
    secdef: false, exposed: "service_role", takesIdFromArguments: "p_organization_id, p_user_id", why: "Quota counters; server calls it (0034/0037).",
  },
  "public.check_invitation_group_same_org()": { secdef: false, exposed: "service_role", why: "Trigger: an invitation's group must be in the same school (0041)." },
  "public.check_rate_limit(p_key text, p_max_count integer, p_window_seconds integer)": {
    secdef: true, exposed: "service_role", why: "Rate limiter; anyone able to call it could burn another user's bucket (0019/0037 closed that).",
  },
  "public.claim_invitation_use(p_invitation_id uuid)": {
    secdef: false, exposed: "service_role", takesIdFromArguments: "p_invitation_id", why: "Atomic invitation use counter (0020).",
  },
  "public.email_domain_allowed()": { secdef: true, exposed: "service_role", why: "Sign-up domain rule (0013/0019)." },
  "public.email_domain_allowed_for_magic_link()": { secdef: true, exposed: "service_role", why: "Magic-link domain rule (0014/0019)." },
  "public.join_org_by_domain(p_user_id uuid)": {
    secdef: true, exposed: "service_role", takesIdFromArguments: "p_user_id", why: "Join by email domain (0039); takes the user id as an argument, so it must stay service-role only.",
  },
  "public.prune_rate_limit_buckets(p_older_than interval)": { secdef: true, exposed: "service_role", why: "Cleanup job (0037)." },
  "private.user_org_ids()": { secdef: true, exposed: "private-schema", why: "RLS helper: the caller's active schools." },
  "private.is_org_admin(target_org uuid)": { secdef: true, exposed: "private-schema", why: "RLS helper (checks the CALLER, via auth.uid())." },
  "private.is_org_approver(target_org uuid)": { secdef: true, exposed: "private-schema", why: "RLS helper (checks the CALLER)." },
  "private.org_admin_org_ids()": { secdef: true, exposed: "private-schema", why: "RLS helper." },
  "private.is_super_admin()": { secdef: true, exposed: "private-schema", why: "RLS helper." },
  "private.handle_new_auth_user()": { secdef: true, exposed: "private-schema", why: "Trigger: creates the profile row for a new login." },
  "private.prevent_platform_role_escalation()": { secdef: false, exposed: "private-schema", why: "Trigger: only the service role may change platform_role." },
  "private.set_updated_at()": { secdef: false, exposed: "private-schema", why: "Trigger helper." },
  "private.protect_prepare_via_server()": { secdef: false, exposed: "private-schema", why: "Trigger: only the platform owner (SQL editor / service role) may switch preparing PDFs on the print server on for an organization (0058)." },
  "private.print_job_transition_allowed(from_status text, to_status text)": { secdef: false, exposed: "private-schema", why: "Job state machine rule." },
  "private.validate_print_job_transition()": { secdef: true, exposed: "private-schema", why: "Trigger: rejects illegal job state changes." },
  "private.prevent_last_authenticated_at_tampering()": { secdef: false, exposed: "private-schema", why: "Trigger (0016/0019)." },
  "private.prevent_device_unrevoke()": { secdef: false, exposed: "private-schema", why: "Trigger: a revoked device stays revoked." },
  "private.setup_key_for(p_device_type text, p_variant text)": { secdef: false, exposed: "private-schema", why: "Pure helper." },
  "private.fill_setup_feedback()": { secdef: true, exposed: "private-schema", why: "Trigger: fills school/user from the device row (0042)." },
  "private.prevent_profile_email_change()": { secdef: false, exposed: "private-schema", why: "Trigger: email changes only by the service role." },
};

/**
 * Functions a signed-in user or anon may EXECUTE through the API. NONE today (every RPC goes through the server's
 * service-role client). If someone adds one, add its name here WITH a probe in RPC_PROBES that calls it as a School A user
 * using School B's ids and proves nothing of B's is read or changed.
 */
const API_CALLABLE_BY_USERS: string[] = [];
interface RpcProbe { fn: string; sql: string; params?: unknown[] }
const RPC_PROBES: RpcProbe[] = [];

/** One real call per public function, used to prove anon and a School A user are refused and the server is not. */
const A = IDS.A;
const B = IDS.B;
const CALLS: Record<string, { sql: string; params?: unknown[]; skipControl?: string }> = {
  adjust_monthly_usage: {
    sql: `select public.adjust_monthly_usage($1, $2, '2026-11', 1, 1, 1, 1, 'physical_sheets', null, 'consume')`,
    params: [B.org, B.users.member], // School A caller, School B ids
  },
  check_invitation_group_same_org: { sql: `select public.check_invitation_group_same_org()`, skipControl: "trigger function cannot be called directly even by the server" },
  check_rate_limit: { sql: `select public.check_rate_limit('print_submit:' || $1, 1, 60)`, params: [B.users.member] },
  claim_invitation_use: { sql: `select public.claim_invitation_use((select id from public.organization_invitations where organization_id = $1))`, params: [B.org], skipControl: "subselect reads a table the caller cannot see" },
  email_domain_allowed: { sql: `select public.email_domain_allowed()` },
  email_domain_allowed_for_magic_link: { sql: `select public.email_domain_allowed_for_magic_link()` },
  join_org_by_domain: { sql: `select public.join_org_by_domain($1)`, params: [NOMEMBER] },
  prune_rate_limit_buckets: { sql: `select public.prune_rate_limit_buckets('1 day'::interval)` },
};

interface Fn { sig: string; schema: string; name: string; secdef: boolean; cfg: string[] | null; anonX: boolean; authX: boolean; svcX: boolean }
let fns: Fn[] = [];

beforeAll(async () => {
  fns = await fx.admin<Fn>(
    `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
            n.nspname as schema, p.proname as name, p.prosecdef as secdef, p.proconfig as cfg,
            has_function_privilege('anon', p.oid, 'execute') as "anonX",
            has_function_privilege('authenticated', p.oid, 'execute') as "authX",
            has_function_privilege('service_role', p.oid, 'execute') as "svcX"
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     order by 1`,
  );
});

describe("SQL functions", () => {
  it("every function in public/private is listed in FUNCTIONS (fails closed on a new function)", () => {
    const found = fns.map((f) => f.sig);
    expect(
      found.filter((s) => !FUNCTIONS[s]),
      "New function(s): add them to FUNCTIONS in functions-columns.db.test.ts (and a CALLS probe if in public), stating who may execute them.",
    ).toEqual([]);
    expect(Object.keys(FUNCTIONS).filter((s) => !found.includes(s)), "stale FUNCTIONS entries").toEqual([]);
  });

  it("SECURITY DEFINER flag matches what each function was reviewed as", () => {
    expect(fns.filter((f) => FUNCTIONS[f.sig] && FUNCTIONS[f.sig]!.secdef !== f.secdef).map((f) => `${f.sig}: secdef=${f.secdef}`)).toEqual([]);
  });

  it("every SECURITY DEFINER function has a fixed EMPTY search_path (so nobody can shadow a table or function)", () => {
    const bad = fns.filter((f) => f.secdef && !(f.cfg ?? []).some((c) => /^search_path=("")?$/.test(c)));
    expect(bad.map((f) => `${f.sig}: ${JSON.stringify(f.cfg)}`)).toEqual([]);
  });

  it("every other function also pins a search_path (the repo's convention; the Supabase linter checks it)", () => {
    expect(fns.filter((f) => !f.secdef && !(f.cfg ?? []).some((c) => c.startsWith("search_path="))).map((f) => f.sig)).toEqual([]);
  });

  it("public functions: anon and signed-in users hold NO execute right; the service role does", () => {
    const pub = fns.filter((f) => f.schema === "public");
    expect(pub.filter((f) => f.anonX).map((f) => `${f.sig}: anon can execute`)).toEqual([]);
    const authOk = pub.filter((f) => f.authX).map((f) => f.name);
    expect(authOk.sort(), "a function callable by signed-in users needs an entry in API_CALLABLE_BY_USERS and an RPC_PROBES cross-school probe").toEqual([...API_CALLABLE_BY_USERS].sort());
    expect(pub.filter((f) => !f.svcX).map((f) => `${f.sig}: service_role cannot execute`)).toEqual([]);
  });

  it("the private schema is not usable by anon or signed-in users (so its helpers cannot be called through the API)", async () => {
    const r = await fx.admin<{ r: string; u: boolean }>(
      `select r, has_schema_privilege(r, 'private', 'usage') u from unnest(array['anon','authenticated']) r`,
    );
    expect(r.filter((x) => x.u)).toEqual([]);
    for (const actor of [actorByName("anon"), actorByName("a_admin")]) {
      const o = await fx.run(actor, `select private.is_org_admin($1)`, [B.org]);
      expect(o.ok, `${actor.name} called private.is_org_admin`).toBe(false);
      if (!o.ok) expect(o.code).toBe("42501");
    }
  });

  it("every public function has a CALLS probe", () => {
    expect(fns.filter((f) => f.schema === "public" && !CALLS[f.name]).map((f) => f.sig)).toEqual([]);
  });

  for (const [name, call] of Object.entries(CALLS)) {
    it(`${name}: refused for anon and for a School A user (even when handed School B's ids); the server can still call it`, async () => {
      for (const actor of [actorByName("anon"), actorByName("a_admin"), actorByName("a_member"), actorByName("nomember")]) {
        const o = await fx.run(actor, call.sql, call.params);
        expect(denied(o), `${actor.name} calling ${name}: ${show(o)}`).toBe(true);
      }
      if (!call.skipControl) {
        const c = await fx.run(SERVICE, call.sql, call.params);
        expect(c.ok, `control: the service role should be able to call ${name}: ${show(c)}`).toBe(true);
      }
    });
  }

  it("RPC_PROBES: every function callable by users is safe against cross-school ids (none exist today)", async () => {
    for (const p of RPC_PROBES) {
      const o = await fx.run(actorByName("a_admin"), p.sql, p.params);
      expect(denied(o) || (o.ok && o.rows.every((r) => Object.values(r).every((v) => v === null || v === false))), `${p.fn}: ${show(o)}`).toBe(true);
    }
  });

  it("join_org_by_domain trusts its argument, so it is only safe because anon/authenticated cannot call it: verified above; here the server path ignores another school's user", async () => {
    // Service role only: handing it a user who already belongs to School B must never add them to School A.
    await fx.admin(`update organizations set join_mode = 'invite_or_domain', allowed_domains = '{school-a.test}' where id = $1`, [A.org]);
    try {
      const o = await fx.run(SERVICE, `select public.join_org_by_domain($1) as r`, [B.users.member]);
      expect(o.ok && o.rows[0]!.r).toBe(null); // B's member has a membership row already: never auto-(re)added.
    } finally {
      await fx.admin(`update organizations set join_mode = 'invite_only', allowed_domains = '{}' where id = $1`, [A.org]);
    }
  });
});

describe("defaults for FUTURE objects (the backstop from 0031/0040)", () => {
  it("a table created tomorrow in public gives nothing to anon and no TRUNCATE/REFERENCES/TRIGGER to signed-in users", async () => {
    await fx.pg.exec("begin");
    try {
      await fx.pg.exec(`create table public.zz_future_table (id int primary key)`);
      const r = (
        await fx.pg.query<{ p: string; g: string; h: boolean }>(
          `select p as p, g as g, has_table_privilege(g, 'public.zz_future_table', p) as h
           from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p, unnest(array['anon','authenticated']) g`,
        )
      ).rows;
      const allowedForAuthenticated = ["SELECT", "INSERT", "UPDATE", "DELETE"]; // 0031 on purpose; only RLS then protects the rows
      expect(
        r.filter((x) => x.h && (x.g === "anon" || !allowedForAuthenticated.includes(x.p))).map((x) => `${x.g} gets ${x.p} on a brand-new table`),
      ).toEqual([]);
    } finally {
      await fx.pg.exec("rollback");
    }
  });

  // KNOWN GAP [Low, preventive]: Postgres gives EXECUTE to PUBLIC on every new function, and 0040's default-privilege
  // revokes only name anon/authenticated, not PUBLIC. So a function added in a future migration is callable through the API by
  // anon and signed-in users unless that migration revokes it by hand (0012 forgot; 0019 fixed it). Fix: add
  // `alter default privileges in schema public revoke execute on functions from public;` (needs a new migration; not done here).
  const futureFnBody = async () => {
    await fx.pg.exec("begin");
    try {
      await fx.pg.exec(`create function public.zz_future_fn() returns int language sql as $$ select 1 $$`);
      const r = (
        await fx.pg.query<{ g: string; h: boolean }>(
          `select g, has_function_privilege(g, 'public.zz_future_fn()', 'execute') h from unnest(array['anon','authenticated']) g`,
        )
      ).rows;
      expect(r.filter((x) => x.h).map((x) => `${x.g} can execute a brand-new function`)).toEqual([]);
    } finally {
      await fx.pg.exec("rollback");
    }
  };
  it.fails("KNOWN GAP [Low] a function created tomorrow in public cannot be executed by anon or signed-in users", futureFnBody);
  it("KNOWN GAP is still reproducible: a brand-new public function is executable by anon through PUBLIC", async () => {
    await fx.pg.exec("begin");
    try {
      await fx.pg.exec(`create function public.zz_future_fn() returns int language sql as $$ select 1 $$`);
      const r = (await fx.pg.query<{ h: boolean }>(`select has_function_privilege('anon', 'public.zz_future_fn()', 'execute') h`)).rows;
      expect(r[0]!.h).toBe(true);
    } finally {
      await fx.pg.exec("rollback");
    }
  });
});

// =====================================================================================================================
// 2. SECRET COLUMNS
// =====================================================================================================================
/**
 * Every column whose name looks like a secret (hash / secret / token / password / key / code / credential). A signed-in user
 * must not be able to SELECT the ones marked `readable: false`. A column that matches the pattern and is not listed here
 * fails the test, so a new secret column cannot slip in unreviewed.
 */
const SECRET_NAME = /(hash|secret|token|passw|credential|api_?key|private_?key|enrollment|(^|_)code$)/i;
const COLUMN_SECRETS: Record<string, { readable: boolean; why: string; gap?: { severity: "High" | "Medium" | "Low"; summary: string } }> = {
  "member_devices.token_hash": { readable: false, why: "SHA-256 of the print-address token (0032). Column-level grant leaves it out, so even the device's owner and School admins cannot read it." },
  "agents.device_secret_hash": {
    readable: false,
    why: "Hash of the print server's secret. Only the server (service role) should ever read it.",
    gap: { severity: "Low", summary: "authenticated has table-level SELECT on agents, so a School's own admins (RLS limits it to their school; never another school) can read device_secret_hash, and it is also in the Realtime-published agents table. Fix: grant column-level SELECT without it, as 0032 did for member_devices." },
  },
  "agents.enrollment_code": { readable: true, why: "One-time install code (24 h). The admin page shows it to the school's own admins on purpose (AgentsPanel). Stored in plain text." },
  "agents.enrollment_code_expires_at": { readable: true, why: "Just a date, shown to admins next to the code." },
  "organization_invitations.code": { readable: true, why: "The join code an admin hands out. The table is admin-only (RLS), so members cannot read it." },
  "organization_members.user_code": { readable: true, why: "Short member code printed on job stamps (not a secret)." },
  "printers.status_code": { readable: true, why: "Printer status code from SNMP (not a secret)." },
};

describe("secret-looking columns", () => {
  let found: string[] = [];
  beforeAll(async () => {
    const cols = await fx.admin<{ k: string }>(
      `select table_name || '.' || column_name as k from information_schema.columns where table_schema = 'public' order by 1`,
    );
    found = cols.map((c) => c.k).filter((k) => SECRET_NAME.test(k.split(".")[1]!));
  });

  it("every column that looks like a secret is reviewed in COLUMN_SECRETS (fails closed on a new one)", () => {
    expect(found.filter((k) => !COLUMN_SECRETS[k]), "New secret-looking column(s): add them to COLUMN_SECRETS with readable true/false and why.").toEqual([]);
    expect(Object.keys(COLUMN_SECRETS).filter((k) => !found.includes(k)), "stale COLUMN_SECRETS entries").toEqual([]);
  });

  for (const [key, spec] of Object.entries(COLUMN_SECRETS)) {
    const [table, col] = key.split(".") as [string, string];
    if (spec.readable) {
      it(`${key} is readable on purpose (${spec.why.slice(0, 60)}...) but NEVER by anon`, async () => {
        const r = await fx.admin<{ h: boolean }>(`select has_column_privilege('anon', $1::regclass, $2, 'select') h`, [`public.${table}`, col]);
        expect(r[0]!.h).toBe(false);
      });
      continue;
    }
    const body = async () => {
      const problems: string[] = [];
      for (const g of ["anon", "authenticated"]) {
        const r = await fx.admin<{ h: boolean }>(`select has_column_privilege($1, $2::regclass, $3, 'select') h`, [g, `public.${table}`, col]);
        if (r[0]!.h) problems.push(`${g} holds SELECT on ${key}`);
      }
      // The strongest caller for each school: its own admin (who can see the rows) must still be refused the column.
      for (const name of ["a_admin", "b_admin", "a_member"] as const) {
        const o = await fx.run(actorByName(name), `select ${col} from public.${table}`);
        if (!(!o.ok && o.code === "42501")) problems.push(`${name} could select ${key}: ${show(o)}`);
      }
      const u = await fx.admin<{ h: boolean }>(`select has_column_privilege('authenticated', $1::regclass, $2, 'update') h`, [`public.${table}`, col]);
      if (u[0]!.h) problems.push(`authenticated can UPDATE ${key}`);
      expect(problems).toEqual([]);
    };
    if (spec.gap) {
      // KNOWN GAP (see the object above). it.fails: green while open, red the day it is closed (then remove the marker).
      it.fails(`KNOWN GAP [${spec.gap.severity}] ${key} must not be readable by signed-in users`, body);
      it(`KNOWN GAP is still reproducible: ${key}`, async () => {
        const o = await fx.run(actorByName("a_admin"), `select ${col} from public.${table} where organization_id = $1`, [A.org]);
        expect(o.ok && o.rows.length > 0, spec.gap!.summary).toBe(true);
      });
    } else {
      it(`${key} is hidden from anon and from every signed-in user (${spec.why.slice(0, 60)}...)`, body);
    }
  }

  it("member_devices: `select *` fails for signed-in users (list columns explicitly), and the token hash cannot be set by update", async () => {
    const o = await fx.run(actorByName("a_member"), `select * from public.member_devices`);
    expect(!o.ok && o.code).toBe("42501");
    const u = await fx.run(actorByName("a_member"), `update public.member_devices set token_hash = repeat('f', 64) where id = $1`, [A.devices.member]);
    expect(!u.ok && u.code).toBe("42501");
  });
});

// =====================================================================================================================
// 3. REALTIME + STORAGE POLICIES (policy logic only; the stubs are in ../harness.ts)
// =====================================================================================================================
describe("Realtime broadcast policy (realtime.messages)", () => {
  const topicA = `org-${A.org}:jobs`;
  const topicB = `org-${B.org}:jobs`;
  const select = `select count(*)::int as n from realtime.messages where extension = 'broadcast'`;
  beforeAll(async () => {
    await fx.admin(`insert into realtime.messages (extension, topic) values ('broadcast', $1), ('broadcast', $2)`, [topicA, topicB]);
  });
  const cases: { who: string; topic: string; read: boolean; write: boolean }[] = [
    { who: "a_admin", topic: topicA, read: true, write: true },
    { who: "a_member", topic: topicA, read: true, write: true },
    { who: "a_admin", topic: topicB, read: false, write: false },
    { who: "a_member", topic: topicB, read: false, write: false },
    { who: "b_admin", topic: topicA, read: false, write: false },
    { who: "b_member", topic: topicA, read: false, write: false },
    { who: "b_member", topic: topicB, read: true, write: true },
    { who: "nomember", topic: topicA, read: false, write: false },
    { who: "nomember", topic: topicB, read: false, write: false },
  ];
  for (const c of cases) {
    it(`${c.who} on the channel of ${c.topic.startsWith(`org-${A.org}`) ? "School A" : "School B"}: read ${c.read ? "allowed" : "denied"}, send ${c.write ? "allowed" : "denied"}`, async () => {
      const actor = actorByName(c.who as never);
      const r = await fx.run(actor, select, [], { topic: c.topic });
      expect(r.ok, `read must be answered by the policy, not by a missing grant: ${show(r)}`).toBe(true);
      expect(r.ok && (r.rows[0]!.n as number) > 0, `read: ${show(r)}`).toBe(c.read);
      const w = await fx.run(actor, `insert into realtime.messages (extension, topic) values ('broadcast', $1)`, [c.topic], { topic: c.topic });
      expect(w.ok && w.affected === 1, `send: ${show(w)}`).toBe(c.write);
      if (!c.write) expect(!w.ok && w.message, "denied by the row-level-security policy").toMatch(/row-level security/);
    });
  }
  it("anon cannot touch realtime.messages at all", async () => {
    const r = await fx.run(actorByName("anon"), select, [], { topic: topicA });
    expect(!r.ok && r.code).toBe("42501");
  });
  it("a non-broadcast (presence/postgres_changes) message is never allowed by these policies", async () => {
    const w = await fx.run(actorByName("a_admin"), `insert into realtime.messages (extension, topic) values ('presence', $1)`, [topicA], { topic: topicA });
    expect(denied(w)).toBe(true);
  });
});

describe("Storage policy on print-job files (storage.objects)", () => {
  const P = (org: string, job: string, file = "original.pdf") => `org/${org}/jobs/${job}/${file}`;
  const objects = {
    aMember: P(A.org, A.jobMember),
    aApprover: P(A.org, A.jobApprover),
    bMember: P(B.org, B.jobMember),
    bApprover: P(B.org, B.jobApprover),
    spoofAOrgBJob: P(A.org, B.jobMember), // path claims School A, job belongs to School B
    spoofBOrgAJob: P(B.org, A.jobMember),
    wrongBucket: P(A.org, A.jobMember, "elsewhere.pdf"),
  };
  beforeAll(async () => {
    for (const [k, name] of Object.entries(objects)) {
      await fx.admin(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [k === "wrongBucket" ? "other-bucket" : "print-jobs", name]);
    }
  });
  const sel = `select name from storage.objects`;
  const visible = async (who: string) => {
    const o = await fx.run(actorByName(who as never), sel);
    if (!o.ok) throw new Error(`${who}: ${show(o)}`);
    return new Set(o.rows.map((r) => r.name as string));
  };
  it("the print-jobs bucket is private", async () => {
    const r = await fx.admin<{ public: boolean }>(`select public from storage.buckets where id = 'print-jobs'`);
    expect(r).toEqual([{ public: false }]);
  });
  it("a member sees only the files of jobs they created; nothing of the other school; spoofed paths match nobody", async () => {
    expect(await visible("a_member")).toEqual(new Set([objects.aMember]));
    expect(await visible("b_member")).toEqual(new Set([objects.bMember]));
  });
  it("an approver or admin sees every job file of their own school and none of the other's", async () => {
    expect(await visible("a_approver")).toEqual(new Set([objects.aMember, objects.aApprover]));
    expect(await visible("a_admin")).toEqual(new Set([objects.aMember, objects.aApprover]));
    expect(await visible("b_admin")).toEqual(new Set([objects.bMember, objects.bApprover]));
  });
  it("a user with no school and anon see no job files", async () => {
    expect(await visible("nomember")).toEqual(new Set());
    expect(await visible("anon")).toEqual(new Set());
  });
  it("nobody signed in can upload, replace or delete job files directly (uploads go through the server)", async () => {
    const problems: string[] = [];
    for (const actor of ACTORS) {
      for (const [op, sql, params] of [
        ["insert", `insert into storage.objects (bucket_id, name) values ('print-jobs', $1)`, [P(actor.school === "B" ? B.org : A.org, "dddddddd-0000-4000-8000-000000000001")]],
        ["update", `update storage.objects set name = name where bucket_id = 'print-jobs'`, []],
        ["delete", `delete from storage.objects where bucket_id = 'print-jobs'`, []],
      ] as const) {
        const o = await fx.run(actor, sql, [...params]);
        if (!denied(o)) problems.push(`${actor.name} ${op}: ${show(o)}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("Realtime publication (which tables stream row changes)", () => {
  it("only agents, print_jobs and remote_commands are published; each has row-level security (Realtime applies it per subscriber)", async () => {
    const r = await fx.admin<{ tablename: string; rls: boolean }>(
      `select pt.tablename, c.relrowsecurity as rls from pg_publication_tables pt
       join pg_class c on c.relname = pt.tablename and c.relnamespace = pt.schemaname::regnamespace
       where pt.pubname = 'supabase_realtime' order by 1`,
    );
    expect(r.map((x) => x.tablename)).toEqual(["agents", "print_jobs", "remote_commands"]);
    expect(r.filter((x) => !x.rls)).toEqual([]);
  });
});
