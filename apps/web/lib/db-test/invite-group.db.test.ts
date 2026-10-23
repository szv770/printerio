import { describe, it, expect, beforeAll } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
const ORG = "00000000-0000-0000-0000-0000000000a1";
const ORG2 = "00000000-0000-0000-0000-0000000000a2";
const ADMIN = "00000000-0000-0000-0000-0000000000b1";
const G1 = "00000000-0000-0000-0000-0000000000c1";
const G2 = "00000000-0000-0000-0000-0000000000c2";

beforeAll(async () => {
  db = await createDb();
  await db.admin(`insert into organizations (id, name, slug) values ($1,'A','a'),($2,'B','b')`, [ORG, ORG2]);
  await db.admin(`insert into auth.users (id, email, email_confirmed_at) values ($1,'a@x.org',now())`, [ADMIN]);
  await db.admin(`insert into groups (id, organization_id, name) values ($1,$3,'Grade 5'),($2,$4,'Other school')`, [G1, G2, ORG, ORG2]);
}, 240_000);

describe("invitation group (migration 0041)", () => {
  it("stores a group from the same organization", async () => {
    const rows = await db.admin<{ group_id: string }>(
      `insert into organization_invitations (organization_id, code, role, created_by, group_id) values ($1,'aaaaaaaaaaaa','student',$2,$3) returning group_id`,
      [ORG, ADMIN, G1],
    );
    expect(rows[0]!.group_id).toBe(G1);
  });
  it("refuses a group from another organization", async () => {
    await expect(
      db.admin(`insert into organization_invitations (organization_id, code, role, created_by, group_id) values ($1,'bbbbbbbbbbbb','student',$2,$3)`, [ORG, ADMIN, G2]),
    ).rejects.toThrow(/same organization/i);
  });
  it("keeps the invite (group cleared) when the group is deleted", async () => {
    await db.admin(`delete from groups where id=$1`, [G1]);
    const rows = await db.admin<{ group_id: string | null }>(`select group_id from organization_invitations where code='aaaaaaaaaaaa'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.group_id).toBeNull();
  });
});
