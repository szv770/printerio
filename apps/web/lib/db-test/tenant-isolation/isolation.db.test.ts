import { describe, it, expect, beforeAll } from "vitest";
import { ACTORS, IDS, SERVICE, createFixture, type Actor, type Fixture, type Outcome, type School } from "./fixture";
import { ATTACKS, EXPECTED, type Level, type TableAccess } from "./expected-access";

/**
 * Two-school isolation matrix (docs/TENANT-ISOLATION-TESTS.md). One replay of every real migration into
 * PGlite, two seeded schools, then every public table is exercised as seven different callers
 * (School A admin / approver / member, School B admin / member, a signed-in user with no school, anon)
 * for select, insert, update and delete. Each statement runs in a transaction that is rolled back.
 *
 * It fails closed: a new table with no entry in expected-access.ts fails the "coverage" test.
 */

let fx: Fixture;
interface RowInfo {
  key: string;
  pk: Record<string, string>;
  school: School | null;
  owner: string | null;
}
interface TableMeta {
  pk: string[];
  rls: boolean;
  orgCol: boolean;
  updateCol: string;
}
let tables: string[] = [];
const meta: Record<string, TableMeta> = {};
const rows: Record<string, RowInfo[]> = {};

const rank = (l: Level) => ({ admin: 3, approver: 2, member: 1, none: 99 })[l];
const schoolOf = (id: string | null): School | null => (id === IDS.A.org ? "A" : id === IDS.B.org ? "B" : null);
const q = (s: string) => `"${s}"`;

beforeAll(async () => {
  fx = await createFixture();
  tables = (
    await fx.admin<{ relname: string }>(
      `select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') order by 1`,
    )
  ).map((r) => r.relname);
  for (const t of tables) {
    const pk = (
      await fx.admin<{ attname: string }>(
        `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = $1::regclass and i.indisprimary order by array_position(i.indkey::int2[], a.attnum)`,
        [`public.${t}`],
      )
    ).map((r) => r.attname);
    const cols = await fx.admin<{ column_name: string; can_update: boolean }>(
      `select column_name, has_column_privilege('authenticated', $1::regclass, column_name, 'UPDATE') as can_update
       from information_schema.columns where table_schema = 'public' and table_name = $2 order by ordinal_position`,
      [`public.${t}`, t],
    );
    const nonPk = cols.filter((c) => !pk.includes(c.column_name));
    meta[t] = {
      pk,
      rls: (await fx.admin<{ r: boolean }>(`select relrowsecurity r from pg_class where oid = $1::regclass`, [`public.${t}`]))[0]!.r,
      orgCol: cols.some((c) => c.column_name === "organization_id"),
      updateCol: (nonPk.find((c) => c.can_update) ?? nonPk[0] ?? { column_name: pk[0]! }).column_name,
    };
    const spec = EXPECTED[t];
    if (!spec || pk.length === 0) continue;
    const list = await fx.admin<Record<string, string | null>>(
      `select ${pk.map((c) => `t.${q(c)}::text as ${q(c)}`).join(", ")}, (${spec.school ?? "null"})::text as __school, (${spec.owner ?? "null"})::text as __owner from public.${q(t)} t`,
    );
    rows[t] = list.map((r) => ({
      key: pk.map((c) => r[c]).join("|"),
      pk: Object.fromEntries(pk.map((c) => [c, r[c]!])),
      school: schoolOf(r.__school ?? null),
      owner: r.__owner ?? null,
    }));
  }
}, 120_000);

// ---- helpers -------------------------------------------------------------------------------------------------------
const isDenied = (o: Outcome) => (o.ok ? o.affected === 0 : o.code === "42501");
/** RLS let the statement reach the row; a later foreign-key rule (23503/23001) is what stopped a delete. */
const isAllowed = (o: Outcome) => (o.ok ? o.affected >= 1 : o.code === "23503" || o.code === "23001");
const show = (o: Outcome) => (o.ok ? `ok(${o.affected} row${o.affected === 1 ? "" : "s"})` : `${o.code}: ${o.message}`);

function whereByPk(t: string, r: RowInfo, start = 1) {
  return { sql: meta[t]!.pk.map((c, i) => `${q(c)} = $${start + i}`).join(" and "), params: meta[t]!.pk.map((c) => r.pk[c]) };
}

function expectedVisible(spec: TableAccess, list: RowInfo[], actor: Actor): Set<string> {
  if (spec.shared) return new Set(list.map((r) => r.key));
  if (actor.school === null) {
    // No school: only rows you own, and only where members see their own rows anyway (your own profile).
    return new Set(spec.select.member === "own" ? list.filter((r) => r.owner === actor.userId).map((r) => r.key) : []);
  }
  const level = spec.select[actor.roleKey!];
  return new Set(
    list
      .filter((r) => r.school === actor.school && (level === "all" || (level === "own" && r.owner === actor.userId)))
      .map((r) => r.key),
  );
}

function expectedWrite(spec: TableAccess, level: Level, r: RowInfo, actor: Actor): boolean {
  if (level === "none" || actor.role !== "authenticated") return false;
  if (spec.ownOnly) return r.owner === actor.userId; // "your own row" (a profile needs no school at all)
  return actor.school !== null && r.school === actor.school && actor.rank >= rank(level);
}

// ---- coverage: fail closed ----------------------------------------------------------------------------------------
describe("coverage (fails closed when a table is added without stating its access)", () => {
  it("every table in public has an entry in expected-access.ts, and no entry is stale", () => {
    const missing = tables.filter((t) => !EXPECTED[t]);
    const stale = Object.keys(EXPECTED).filter((t) => !tables.includes(t));
    expect(
      missing,
      `New table(s) ${missing.join(", ")}: add an entry to lib/db-test/tenant-isolation/expected-access.ts stating who may read and write it (see docs/TENANT-ISOLATION-TESTS.md).`,
    ).toEqual([]);
    expect(stale, `expected-access.ts has entries for tables that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });

  it("row-level security is ON for every table in public", () => {
    expect(tables.filter((t) => !meta[t]!.rls)).toEqual([]);
  });

  it("every table has a primary key (the test addresses rows by it)", () => {
    expect(tables.filter((t) => meta[t]!.pk.length === 0)).toEqual([]);
  });

  it("anon holds no privilege on any table and no policy is open to anon or PUBLIC", async () => {
    const privs = await fx.admin<{ t: string; p: string }>(
      `select c.relname t, p from pg_class c, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
         and (has_table_privilege('anon', c.oid, p) or (p in ('SELECT','INSERT','UPDATE','REFERENCES') and has_any_column_privilege('anon', c.oid, p)))`,
    );
    expect(privs).toEqual([]);
    const pol = await fx.admin<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies where schemaname = 'public' and (roles && array['anon','public']::name[])`,
    );
    expect(pol).toEqual([]);
  });

  it("the fixture has data for BOTH schools in every school table (so a leak has something to leak)", () => {
    const thin: string[] = [];
    for (const [t, spec] of Object.entries(EXPECTED)) {
      if (spec.shared) {
        if ((rows[t]?.length ?? 0) < 1) thin.push(`${t}: no shared rows`);
        continue;
      }
      for (const s of ["A", "B"] as School[]) {
        if (!(rows[t] ?? []).some((r) => r.school === s)) thin.push(`${t}: no rows for School ${s}`);
      }
      if (spec.ownOnly) {
        for (const a of ACTORS.filter((x) => x.school === "A")) {
          if (!(rows[t] ?? []).some((r) => r.owner === a.userId)) thin.push(`${t}: ${a.name} owns no row`);
        }
      }
    }
    expect(thin).toEqual([]);
  });

  it("the grants say exactly what the matrix says (a write with no level has NO column or table privilege for signed-in users)", async () => {
    const wrong: string[] = [];
    for (const [t, spec] of Object.entries(EXPECTED)) {
      for (const [op, level] of [["INSERT", spec.insert], ["UPDATE", spec.update], ["DELETE", spec.delete]] as const) {
        // INSERT/UPDATE can be granted per column (member_devices), DELETE only per table.
        const hasTable = (
          await fx.admin<{ h: boolean }>(
            op === "DELETE"
              ? `select has_table_privilege('authenticated', $1::regclass, $2) h`
              : `select has_any_column_privilege('authenticated', $1::regclass, $2) h`,
            [`public.${t}`, op],
          )
        )[0]!.h;
        if (level === "none" && hasTable) wrong.push(`${t}: authenticated holds ${op} but the matrix says nobody signed in may`);
        if (level !== "none" && !hasTable) wrong.push(`${t}: matrix allows ${op} for ${level} but authenticated has no ${op} grant`);
      }
      if (spec.noAccess) {
        const sel = (await fx.admin<{ h: boolean }>(`select has_any_column_privilege('authenticated', $1::regclass, 'SELECT') h`, [`public.${t}`]))[0]!.h;
        if (sel) wrong.push(`${t}: authenticated holds SELECT but the matrix says nobody signed in may even read it`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

// ---- the matrix ---------------------------------------------------------------------------------------------------
for (const t of Object.keys(EXPECTED)) {
  const spec = EXPECTED[t]!;
  describe(`${t}`, () => {
    // A comment per table, in the test output, saying why.
    it(`SELECT: each caller sees exactly what the matrix says (${spec.why.slice(0, 70)}...)`, async () => {
      const problems: string[] = [];
      const list = rows[t] ?? [];
      const sel = `select ${meta[t]!.pk.map((c) => `${q(c)}::text as ${q(c)}`).join(", ")} from public.${q(t)}`;
      for (const actor of ACTORS) {
        const o = await fx.run(actor, sel);
        if (actor.role === "anon" || spec.noAccess) {
          if (!(!o.ok && o.code === "42501")) problems.push(`${actor.name}: expected permission denied, got ${show(o)}`);
          continue;
        }
        if (!o.ok) {
          problems.push(`${actor.name}: unexpected error ${show(o)}`);
          continue;
        }
        const seen = new Set(o.rows.map((r) => meta[t]!.pk.map((c) => r[c]).join("|")));
        const want = expectedVisible(spec, list, actor);
        const byKey = new Map(list.map((r) => [r.key, r]));
        for (const k of seen) if (!want.has(k)) problems.push(`${actor.name}: SEES a row it should not (${k}; belongs to School ${byKey.get(k)?.school ?? "none"})`);
        for (const k of want) if (!seen.has(k)) problems.push(`${actor.name}: cannot see a row it should (${k})`);
      }
      expect(problems).toEqual([]);
    });

    it("INSERT: allowed only for the stated role inside its own school; never for the other school, no-school users or anon", async () => {
      const problems: string[] = [];
      for (const actor of ACTORS) {
        for (const school of ["A", "B"] as School[]) {
          const stmt = spec.makeInsert({ actor, T: IDS[school] });
          const o = await fx.run(actor, stmt.sql, stmt.params, { pre: stmt.pre });
          const should = spec.insert !== "none" && actor.role === "authenticated" && actor.school === school && actor.rank >= rank(spec.insert);
          if (should) {
            if (!(o.ok && o.affected === 1)) problems.push(`${actor.name} -> School ${school}: should be ALLOWED, got ${show(o)}`);
          } else if (!isDenied(o)) {
            problems.push(`${actor.name} -> School ${school}: should be DENIED, got ${show(o)}`);
          }
        }
      }
      // Positive control for "service role only" tables: the same statement works for the server, so the denials above are real.
      if (t !== "profiles") {
        for (const school of ["A", "B"] as School[]) {
          const stmt = spec.makeInsert({ actor: ACTORS.find((a) => a.school === school && a.roleKey === "admin")!, T: IDS[school] });
          const o = await fx.run(SERVICE, stmt.sql, stmt.params, { pre: stmt.pre });
          if (!(o.ok && o.affected === 1)) problems.push(`service_role -> School ${school}: control insert failed, got ${show(o)}`);
        }
      }
      expect(problems).toEqual([]);
    });

    for (const op of ["update", "delete"] as const) {
      it(`${op.toUpperCase()}: every caller x every row, allowed only where the matrix says (and never across schools)`, async () => {
        const problems: string[] = [];
        let allowedSeen = 0;
        for (const actor of ACTORS) {
          for (const r of rows[t] ?? []) {
            const w = whereByPk(t, r);
            const sql =
              op === "update"
                ? `update public.${q(t)} set ${q(meta[t]!.updateCol)} = ${q(meta[t]!.updateCol)} where ${w.sql}`
                : `delete from public.${q(t)} where ${w.sql}`;
            const o = await fx.run(actor, sql, w.params);
            const should = expectedWrite(spec, spec[op], r, actor);
            const crossSchool = actor.school !== null && r.school !== null && r.school !== actor.school;
            if (crossSchool && !isDenied(o)) {
              problems.push(`CROSS-SCHOOL: ${actor.name} ${op} on School ${r.school}'s row ${r.key} got ${show(o)}`);
              continue;
            }
            if (should) {
              allowedSeen++;
              if (!isAllowed(o)) problems.push(`${actor.name} ${op} own-school row ${r.key}: should be ALLOWED, got ${show(o)}`);
            } else if (!isDenied(o)) {
              problems.push(`${actor.name} ${op} row ${r.key} (School ${r.school ?? "none"}): should be DENIED, got ${show(o)}`);
            }
          }
        }
        // Guard against a vacuous pass: a level that allows the write must have been proven at least once.
        if (spec[op] !== "none" && allowedSeen === 0) problems.push(`no allowed ${op} was ever exercised (the matrix says ${spec[op]} may)`);
        expect(problems).toEqual([]);
      });
    }

    // Registered for every table; skipped at run time for tables with no organization_id column (discovered from the schema).
    it("UPDATE cannot MOVE a row into the other school (organization_id changed to the other school)", async (ctx) => {
      if (!meta[t]!.orgCol) return ctx.skip();
      const problems: string[] = [];
      for (const actor of ACTORS.filter((a) => a.school !== null)) {
        const other = actor.school === "A" ? IDS.B.org : IDS.A.org;
        for (const r of (rows[t] ?? []).filter((x) => x.school === actor.school)) {
          const w = whereByPk(t, r, 2);
          const o = await fx.run(actor, `update public.${q(t)} set organization_id = $1 where ${w.sql}`, [other, ...w.params]);
          if (!isDenied(o) && !(!o.ok && spec.moveDenyCodes?.includes(o.code))) problems.push(`${actor.name} moved ${r.key} into the other school: ${show(o)}`);
        }
      }
      expect(problems).toEqual([]);
    });
  });
}

// ---- reference attacks (foreign keys pointing into the other school) ----------------------------------------------
describe("foreign-key attacks by a legitimate member of School A against School B's objects", () => {
  async function attempt(a: (typeof ATTACKS)[number]) {
    const actor = ACTORS.find((x) => x.name === a.as)!;
    const outs = await fx.runSteps(actor, a.steps);
    // Leading "setup" steps must really work, otherwise a later denial proves nothing.
    for (let i = 0; i < (a.setup ?? 0); i++) {
      const o = outs[i];
      if (!o || !o.ok || o.affected < 1) return { kind: "vacuous-setup" as const, detail: `setup step ${i + 1} did not work: ${o ? show(o) : "not run"}` };
    }
    const failedAt = outs.findIndex((o) => !o.ok);
    const deny = a.denyCodes ?? ["42501"];
    if (failedAt >= 0) {
      const o = outs[failedAt] as Extract<Outcome, { ok: false }>;
      return deny.includes(o.code) ? { kind: "denied" as const, detail: `${o.code}: ${o.message}` } : { kind: "unexpected-error" as const, detail: `${o.code}: ${o.message}` };
    }
    const last = outs[outs.length - 1] as Extract<Outcome, { ok: true }>;
    return last.affected >= 1 || last.rows.length >= 1
      ? { kind: "SUCCEEDED" as const, detail: `last step returned ${Math.max(last.affected, last.rows.length)} row(s)` }
      : { kind: "denied" as const, detail: "0 rows" };
  }

  for (const a of ATTACKS) {
    if (!a.gap) {
      it(`blocked: ${a.id} (${a.what})`, async () => {
        const r = await attempt(a);
        expect(r.kind, `${a.what}: ${r.detail}`).toBe("denied");
      });
    } else {
      // KNOWN GAP (${a.gap.severity}): ${a.gap.summary}
      // it.fails keeps CI green while the hole is open and goes RED the day it is fixed (remove the marker then).
      it.fails(`KNOWN GAP [${a.gap.severity}] ${a.id}: ${a.what}`, async () => {
        const r = await attempt(a);
        expect(r.kind, `${a.what}: ${r.detail}`).toBe("denied");
      });
      it(`KNOWN GAP is still reproducible: ${a.id}`, async () => {
        const r = await attempt(a);
        expect(r.kind, `${a.gap!.summary} -> ${r.detail}`).toBe("SUCCEEDED");
      });
    }
  }
});
