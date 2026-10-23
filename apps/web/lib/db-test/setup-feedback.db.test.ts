import { describe, it, expect, beforeAll } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
const ORG = "00000000-0000-0000-0000-0000000000a1";
const ORG2 = "00000000-0000-0000-0000-0000000000a2";
const ADMIN = "00000000-0000-0000-0000-0000000000b1";
const M1 = "00000000-0000-0000-0000-0000000000b2";
const M2 = "00000000-0000-0000-0000-0000000000b3";
const OUT = "00000000-0000-0000-0000-0000000000b4"; // member of another org
const D1 = "00000000-0000-0000-0000-0000000000d1"; // M1 windows
const D2 = "00000000-0000-0000-0000-0000000000d2"; // M2 mac
const hash = (c: string) => c.repeat(64);

beforeAll(async () => {
  db = await createDb();
  await db.admin(`insert into organizations (id, name, slug) values ($1,'A','a'),($2,'B','b')`, [ORG, ORG2]);
  for (const [id, email] of [[ADMIN, "a@x.org"], [M1, "m1@x.org"], [M2, "m2@x.org"], [OUT, "o@x.org"]]) {
    await db.admin(`insert into auth.users (id, email, email_confirmed_at) values ($1,$2,now())`, [id, email]);
  }
  await db.admin(
    `insert into organization_members (user_id, organization_id, role) values ($1,$5,'org_admin'),($2,$5,'student'),($3,$5,'student'),($4,$6,'student')`,
    [ADMIN, M1, M2, OUT, ORG, ORG2],
  );
  await db.admin(`insert into member_devices (id, organization_id, user_id, name, device_type, token_hash) values ($1,$3,$4,'PC','windows',$6),($2,$3,$5,'Mac','mac',$7)`, [D1, D2, ORG, M1, M2, hash("a"), hash("b")]);
}, 240_000);

describe("device_setup_feedback (migration 0042)", () => {
  it("a member answers for their own device; the setup method is filled in by the database", async () => {
    const rows = await db.as<{ setup_key: string; organization_id: string; user_id: string }>(
      "authenticated", M1,
      `insert into device_setup_feedback (device_id, outcome, note) values ($1,'ok','') returning setup_key, organization_id, user_id`, [D1],
    );
    expect(rows[0]).toMatchObject({ setup_key: "windows_manual_wizard", organization_id: ORG, user_id: M1 });
  });
  it("maps every device type to a setup method", async () => {
    const rows = await db.as<{ setup_key: string }>("authenticated", M2, `insert into device_setup_feedback (device_id, outcome) values ($1,'problem') returning setup_key`, [D2]);
    expect(rows[0]!.setup_key).toBe("mac_lpadmin");
  });
  it("only one answer per device", async () => {
    await expect(db.as("authenticated", M1, `insert into device_setup_feedback (device_id, outcome) values ($1,'ok')`, [D1])).rejects.toThrow();
  });
  it("a member cannot answer for someone else's device", async () => {
    await db.admin(`delete from device_setup_feedback where device_id=$1`, [D2]);
    await expect(db.as("authenticated", M1, `insert into device_setup_feedback (device_id, outcome) values ($1,'ok')`, [D2])).rejects.toThrow();
  });
  it("members see only their own answers, admins see their org's, outsiders see none", async () => {
    await db.admin(`insert into device_setup_feedback (device_id, outcome) values ($1,'problem')`, [D2]);
    expect(await db.as("authenticated", M1, `select id from device_setup_feedback`)).toHaveLength(1);
    expect(await db.as("authenticated", ADMIN, `select id from device_setup_feedback`)).toHaveLength(2);
    expect(await db.as("authenticated", OUT, `select id from device_setup_feedback`)).toHaveLength(0);
  });
  it("members cannot edit or delete answers; anon has nothing", async () => {
    expect(await db.as("authenticated", M1, `update device_setup_feedback set outcome='problem' where device_id=$1 returning id`, [D1]).catch(() => [])).toHaveLength(0);
    expect(await db.as("authenticated", M1, `delete from device_setup_feedback returning id`).catch(() => [])).toHaveLength(0);
    await expect(db.as("anon", null, `select 1 from device_setup_feedback`)).rejects.toThrow();
    await expect(db.as("anon", null, `select 1 from setup_confirmations`)).rejects.toThrow();
  });
});

describe("setup_confirmations", () => {
  it("only an admin of the org can confirm, and members of the org can read it", async () => {
    await expect(db.as("authenticated", M1, `insert into setup_confirmations (organization_id, setup_key, confirmed_by) values ($1,'windows_manual_wizard',$2)`, [ORG, M1])).rejects.toThrow();
    const ok = await db.as("authenticated", ADMIN, `insert into setup_confirmations (organization_id, setup_key, confirmed_by) values ($1,'windows_manual_wizard',$2) returning setup_key`, [ORG, ADMIN]);
    expect(ok).toHaveLength(1);
    expect(await db.as("authenticated", M1, `select setup_key from setup_confirmations`)).toHaveLength(1);
    expect(await db.as("authenticated", OUT, `select setup_key from setup_confirmations`)).toHaveLength(0);
  });
  it("an admin cannot confirm for another organization, and can remove their own org's confirmation", async () => {
    await expect(db.as("authenticated", ADMIN, `insert into setup_confirmations (organization_id, setup_key, confirmed_by) values ($1,'mac_lpadmin',$2)`, [ORG2, ADMIN])).rejects.toThrow();
    expect(await db.as("authenticated", ADMIN, `delete from setup_confirmations where setup_key='windows_manual_wizard' returning setup_key`)).toHaveLength(1);
  });
});
