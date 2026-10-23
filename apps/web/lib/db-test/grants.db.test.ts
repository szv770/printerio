import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDb, type Db } from "./harness";

const AUDIT_SQL = readFileSync(path.resolve(__dirname, "../../../../supabase/verify/grants_audit.sql"), "utf8");
let before: Db;
let after: Db;
const audit = (db: Db) => db.admin<{ finding: string; object: string; detail: string }>(AUDIT_SQL);

beforeAll(async () => {
  // "before" = every migration except the F11 cleanup, i.e. what prod has today.
  before = await createDb({ skip: ["0040_grants_cleanup.sql"] });
  after = await createDb();
}, 240_000);

describe("F11 grants audit script", () => {
  it("detects the problems on today's schema (proves the script is real)", async () => {
    const kinds = new Set((await audit(before)).map((r) => r.finding));
    expect(kinds.has("anon_has_table_privilege")).toBe(true);
    expect(kinds.has("authenticated_has_dangerous_table_privilege")).toBe(true);
    expect(kinds.has("authenticated_write_grant_without_policy")).toBe(true);
    expect(kinds.has("public_function_executable_by_authenticated")).toBe(true);
  });
  it("is clean (zero rows) after 0040", async () => {
    expect(await audit(after)).toEqual([]);
  });
});

describe("after 0040 the app's real paths still have what they need", () => {
  const ORG = "00000000-0000-0000-0000-0000000000a1";
  const ADMIN = "00000000-0000-0000-0000-0000000000b1";
  const MEMBER = "00000000-0000-0000-0000-0000000000b2";
  beforeAll(async () => {
    await after.admin(`insert into organizations (id, name, slug) values ($1,'T','t')`, [ORG]);
    for (const [id, email] of [[ADMIN, "a@x.org"], [MEMBER, "m@x.org"]]) {
      await after.admin(`insert into auth.users (id, email, email_confirmed_at) values ($1,$2,now())`, [id, email]);
    }
    await after.admin(`insert into organization_members (user_id, organization_id, role) values ($1,$3,'org_admin'),($2,$3,'student')`, [ADMIN, MEMBER, ORG]);
    await after.admin(`insert into organization_settings (organization_id) values ($1)`, [ORG]);
  });
  it("member reads own org, admin updates org + settings, admin manages members and invitations", async () => {
    expect(await after.as("authenticated", MEMBER, `select id from organizations`)).toHaveLength(1);
    expect(await after.as("authenticated", ADMIN, `update organizations set name='T2' where id=$1 returning id`, [ORG])).toHaveLength(1);
    expect(await after.as("authenticated", ADMIN, `update organization_settings set admins_bypass_restrictions=false where organization_id=$1 returning organization_id`, [ORG])).toHaveLength(1);
    expect(await after.as("authenticated", ADMIN, `update organization_members set role='staff' where user_id=$1 returning user_id`, [MEMBER])).toHaveLength(1);
    expect(
      await after.as("authenticated", ADMIN, `insert into organization_invitations (organization_id, code, role, created_by) values ($1,'abc123def456','student',$2) returning id`, [ORG, ADMIN]),
    ).toHaveLength(1);
  });
  it("service role keeps full access, and anon/authenticated cannot truncate or touch sequences", async () => {
    expect(await after.as("service_role", null, `select count(*)::int n from print_jobs`)).toEqual([{ n: 0 }]);
    await expect(after.as("authenticated", ADMIN, `truncate table audit_logs`)).rejects.toThrow(/permission denied/i);
    await expect(after.as("anon", null, `select * from profiles`)).rejects.toThrow(/permission denied/i);
    await expect(after.as("authenticated", ADMIN, `select nextval('print_jobs_number_seq')`)).rejects.toThrow(/permission denied/i);
  });
});
