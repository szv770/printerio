import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDb, type Db } from "./harness";

/** Migration 0058 (per-organization switch for preparing PDFs on the print server): replayed against the real migrations in PGlite. */
let db: Db;
const ORG = "00000000-0000-0000-0000-0000000000a1";
const ORG2 = "00000000-0000-0000-0000-0000000000a2";
const ADMIN = "00000000-0000-0000-0000-0000000000b1";
const MEMBER = "00000000-0000-0000-0000-0000000000b2";

const flag = async (org: string) => (await db.admin<{ prepare_via_server: boolean }>(`select prepare_via_server from organization_settings where organization_id=$1`, [org]))[0]?.prepare_via_server;

beforeAll(async () => {
  db = await createDb();
  await db.admin(`insert into organizations (id, name, slug) values ($1,'A','a'),($2,'B','b')`, [ORG, ORG2]);
  for (const [id, email] of [[ADMIN, "a@x.org"], [MEMBER, "m@x.org"]]) {
    await db.admin(`insert into auth.users (id, email, email_confirmed_at) values ($1,$2,now())`, [id, email]);
  }
  await db.admin(`insert into organization_members (user_id, organization_id, role) values ($1,$3,'org_admin'),($2,$3,'student')`, [ADMIN, MEMBER, ORG]);
  await db.admin(`insert into organization_settings (organization_id) values ($1) on conflict do nothing`, [ORG]);
  await db.admin(`insert into organization_settings (organization_id) values ($1) on conflict do nothing`, [ORG2]);
}, 240_000);

describe("organization_settings.prepare_via_server (migration 0058)", () => {
  it("is off by default, for every organization", async () => {
    expect(await flag(ORG)).toBe(false);
    expect(await flag(ORG2)).toBe(false);
  });

  it("an organization admin can still change their other settings...", async () => {
    const rows = await db.as("authenticated", ADMIN, `update organization_settings set max_upload_size_bytes = 1000000 where organization_id=$1 returning organization_id`, [ORG]);
    expect(rows).toHaveLength(1);
  });

  it("...but cannot switch preparing on for themselves (the platform owner decides)", async () => {
    await expect(db.as("authenticated", ADMIN, `update organization_settings set prepare_via_server = true where organization_id=$1`, [ORG])).rejects.toThrow(/platform owner/);
    expect(await flag(ORG)).toBe(false);
  });

  it("writing the same value is not a change, so a normal settings save by an admin still works", async () => {
    const rows = await db.as("authenticated", ADMIN, `update organization_settings set prepare_via_server = false, max_upload_size_bytes = 2000000 where organization_id=$1 returning organization_id`, [ORG]);
    expect(rows).toHaveLength(1);
  });

  it("the service role and the SQL editor (postgres) can switch it, for one organization only", async () => {
    await db.as("service_role", null, `update organization_settings set prepare_via_server = true where organization_id=$1`, [ORG]);
    expect(await flag(ORG)).toBe(true);
    expect(await flag(ORG2)).toBe(false);
    await db.admin(`update organization_settings set prepare_via_server = false where organization_id=$1`, [ORG]);
    expect(await flag(ORG)).toBe(false);
  });

  it("re-running the migration changes nothing and does not fail (idempotent), and the protection still holds", async () => {
    const sql = readFileSync(path.resolve(__dirname, "../../../../supabase/migrations/0058_prepare_via_server.sql"), "utf8");
    await db.pg.exec(sql);
    await db.pg.exec(sql);
    await expect(db.as("authenticated", ADMIN, `update organization_settings set prepare_via_server = true where organization_id=$1`, [ORG])).rejects.toThrow(/platform owner/);
  });
});
