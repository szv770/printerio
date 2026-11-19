import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDb, type Db } from "./harness";

/** Migration 0057 (prepare jobs): replayed against the real migrations in PGlite. docs/PREPARE-JOBS-DESIGN.md. */
let db: Db;
const ORG = "00000000-0000-0000-0000-0000000000a1";
const ORG2 = "00000000-0000-0000-0000-0000000000a2";
const ADMIN = "00000000-0000-0000-0000-0000000000b1";
const M1 = "00000000-0000-0000-0000-0000000000b2"; // sender of the prepare job
const M2 = "00000000-0000-0000-0000-0000000000b3"; // another member of the same school
const OUT = "00000000-0000-0000-0000-0000000000b4"; // member of another school
const OUT_ADMIN = "00000000-0000-0000-0000-0000000000b5"; // admin of another school

let seq = 0;
const key = () => `k${++seq}-${"x".repeat(5)}`;

async function insertJob(over: { kind?: string; org?: string; by?: string | null; params?: unknown; source?: string | null; status?: string; dedupe?: string } = {}) {
  const kind = over.kind ?? "prepare_pdf";
  const rows = await db.admin<{ id: string }>(
    `insert into server_jobs (kind, organization_id, requested_by, params, dedupe_key, source_path, status)
     values ($1,$2,$3,$4::jsonb,$5,$6,$7) returning id`,
    [
      kind,
      over.org ?? ORG,
      "by" in over ? over.by : M1,
      JSON.stringify(over.params ?? { choices: { sides: "one" } }),
      over.dedupe ?? key(),
      "source" in over ? over.source : kind === "prepare_pdf" ? `intake/${ORG}/${M1}/a.pdf` : null,
      over.status ?? "queued",
    ],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  db = await createDb();
  await db.admin(`insert into organizations (id, name, slug) values ($1,'A','a'),($2,'B','b')`, [ORG, ORG2]);
  for (const [id, email] of [[ADMIN, "a@x.org"], [M1, "m1@x.org"], [M2, "m2@x.org"], [OUT, "o@x.org"], [OUT_ADMIN, "oa@x.org"]]) {
    await db.admin(`insert into auth.users (id, email, email_confirmed_at) values ($1,$2,now())`, [id, email]);
  }
  await db.admin(
    `insert into organization_members (user_id, organization_id, role) values ($1,$6,'org_admin'),($2,$6,'student'),($3,$6,'student'),($4,$7,'student'),($5,$7,'org_admin')`,
    [ADMIN, M1, M2, OUT, OUT_ADMIN, ORG, ORG2],
  );
}, 240_000);

describe("server_jobs shape (migration 0057)", () => {
  it("library fetch jobs still work exactly as before, with the small params limit", async () => {
    await expect(insertJob({ kind: "library_fetch", by: null, params: { kind: "likkutei", volume: 12 } })).resolves.toBeTruthy();
    await expect(insertJob({ kind: "library_fetch", by: null, params: { pad: "x".repeat(2100) } })).rejects.toThrow();
  });

  it("prepare jobs may carry larger params (up to 16000 bytes) but not more", async () => {
    await expect(insertJob({ params: { pad: "x".repeat(5000) } })).resolves.toBeTruthy();
    await expect(insertJob({ params: { pad: "x".repeat(16100) } })).rejects.toThrow();
  });

  it("a prepare job must say who asked and which file to prepare", async () => {
    await expect(insertJob({ by: null })).rejects.toThrow();
    await expect(insertJob({ source: null })).rejects.toThrow();
  });

  it("knows the cancelled status, and still refuses unknown ones and unknown kinds", async () => {
    await expect(insertJob({ status: "cancelled" })).resolves.toBeTruthy();
    await expect(insertJob({ status: "exploded" })).rejects.toThrow();
    await expect(insertJob({ kind: "burn_everything" })).rejects.toThrow();
  });

  it("result must be a small object", async () => {
    const id = await insertJob();
    await expect(db.admin(`update server_jobs set result = '{"pages":3}'::jsonb where id=$1`, [id])).resolves.toBeDefined();
    await expect(db.admin(`update server_jobs set result = '[1,2]'::jsonb where id=$1`, [id])).rejects.toThrow();
    await expect(
      db.admin(`update server_jobs set result = $2::jsonb where id=$1`, [id, JSON.stringify({ pad: "x".repeat(65000) })]),
    ).rejects.toThrow();
  });

  it("still allows only one active job per dedupe key", async () => {
    const dedupe = key();
    await insertJob({ dedupe });
    await expect(insertJob({ dedupe })).rejects.toThrow();
    await db.admin(`update server_jobs set status='done' where dedupe_key=$1`, [dedupe]);
    await expect(insertJob({ dedupe })).resolves.toBeTruthy();
  });

  it("re-running the migration changes nothing and does not fail (idempotent)", async () => {
    const sql = readFileSync(path.resolve(__dirname, "../../../../supabase/migrations/0057_prepare_jobs.sql"), "utf8");
    await db.pg.exec(sql);
    await db.pg.exec(sql);
    await expect(insertJob()).resolves.toBeTruthy();
    await expect(insertJob({ params: { pad: "x".repeat(16100) } })).rejects.toThrow();
  });
});

describe("who can read prepare jobs (migration 0057)", () => {
  let prepareId: string;
  let libraryId: string;
  beforeAll(async () => {
    await db.admin(`delete from server_jobs`);
    prepareId = await insertJob();
    libraryId = await insertJob({ kind: "library_fetch", by: null, params: { kind: "likkutei", volume: 1 } });
  });
  const ids = async (userId: string) => (await db.as<{ id: string }>("authenticated", userId, `select id from server_jobs`)).map((r) => r.id).sort();

  it("the sender and their school's admins see the prepare job", async () => {
    expect(await ids(M1)).toContain(prepareId);
    expect(await ids(ADMIN)).toContain(prepareId);
  });

  it("another member of the same school does NOT (it holds print choices and a file path)", async () => {
    expect(await ids(M2)).not.toContain(prepareId);
  });

  it("nobody from another school sees it, not even that school's admin", async () => {
    expect(await ids(OUT)).not.toContain(prepareId);
    expect(await ids(OUT_ADMIN)).not.toContain(prepareId);
  });

  it("library jobs stay visible to every member of the school and to nobody else", async () => {
    for (const u of [M1, M2, ADMIN]) expect(await ids(u)).toContain(libraryId);
    for (const u of [OUT, OUT_ADMIN]) expect(await ids(u)).not.toContain(libraryId);
  });

  it("signed-in users cannot write, and anon has no access at all", async () => {
    await expect(
      db.as("authenticated", M1, `insert into server_jobs (kind, organization_id, requested_by, params, dedupe_key, source_path) values ('prepare_pdf',$1,$2,'{}'::jsonb,'zz1','p')`, [ORG, M1]),
    ).rejects.toThrow();
    expect(await db.as("authenticated", M1, `update server_jobs set status='done' where id=$1 returning id`, [prepareId]).catch(() => [])).toHaveLength(0);
    expect(await db.as("authenticated", ADMIN, `delete from server_jobs where id=$1 returning id`, [prepareId]).catch(() => [])).toHaveLength(0);
    await expect(db.as("anon", null, `select 1 from server_jobs`)).rejects.toThrow();
  });

  it("the service role can do everything (that is how the website and print servers write)", async () => {
    const rows = await db.as<{ id: string }>("service_role", null, `select id from server_jobs`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
