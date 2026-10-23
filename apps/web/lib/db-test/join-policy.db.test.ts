import { describe, it, expect, beforeAll } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
const ORG = "00000000-0000-0000-0000-0000000000a1";
const ADMIN = "00000000-0000-0000-0000-0000000000b1";
const STRANGER = "00000000-0000-0000-0000-0000000000c1";
const T1 = "00000000-0000-0000-0000-0000000000d1";

async function addUser(id: string, email: string, confirmed = true) {
  await db.admin(`insert into auth.users (id, email, email_confirmed_at) values ($1,$2,${confirmed ? "now()" : "null"})`, [id, email]);
}
const members = (uid: string) =>
  db.admin<{ role: string; status: string }>(`select role, status from organization_members where user_id=$1`, [uid]);
const join = (uid: string) => db.as<{ r: string | null }>("service_role", null, `select public.join_org_by_domain($1) as r`, [uid]);
const setOrg = (mode: string, domains: string[]) =>
  db.admin(`update organizations set allowed_domains=$1::text[], join_mode=$2 where id=$3`, [`{${domains.join(",")}}`, mode, ORG]);

beforeAll(async () => {
  db = await createDb();
  await db.admin(`insert into organizations (id, name, slug, allowed_domains) values ($1,'Test','test','{lecfl.com}')`, [ORG]);
  await addUser(ADMIN, "admin@lecfl.com");
  await db.admin(`insert into organization_members (user_id, organization_id, role) values ($1,$2,'org_admin')`, [ADMIN, ORG]);
  await addUser(STRANGER, "stranger@gmail.com");
}, 120_000);

describe("join_mode defaults", () => {
  it("existing org defaults to invite only and keeps current members", async () => {
    const o = await db.admin<{ join_mode: string; domain_join_role: string }>(
      `select join_mode, domain_join_role from organizations where id=$1`,
      [ORG],
    );
    expect(o[0]).toEqual({ join_mode: "invite_only", domain_join_role: "student" });
    expect((await members(ADMIN))[0]!.role).toBe("org_admin");
  });
  it("cannot enable domain mode with an empty list, or store junk domains / privileged join roles", async () => {
    await expect(setOrg("invite_or_domain", [])).rejects.toThrow();
    await expect(db.admin(`update organizations set allowed_domains='{"Evil.COM"}' where id=$1`, [ORG])).rejects.toThrow();
    await expect(db.admin(`update organizations set allowed_domains='{"a@b.com"}' where id=$1`, [ORG])).rejects.toThrow();
    await expect(db.admin(`update organizations set domain_join_role='org_admin' where id=$1`, [ORG])).rejects.toThrow();
  });
});

describe("join_org_by_domain", () => {
  it("invite only: a matching school email does NOT join", async () => {
    await addUser(T1, "t1@lecfl.com");
    await setOrg("invite_only", ["lecfl.com"]);
    expect((await join(T1))[0]!.r).toBeNull();
    expect(await members(T1)).toHaveLength(0);
  });
  it("domain mode: exact verified domain joins with the configured role, and is audited", async () => {
    await setOrg("invite_or_domain", ["lecfl.com"]);
    expect((await join(T1))[0]!.r).toBe(ORG);
    expect(await members(T1)).toEqual([{ role: "student", status: "active" }]);
    const a = await db.admin(`select 1 from audit_logs where action='member.joined_by_domain' and actor_id=$1`, [T1]);
    expect(a).toHaveLength(1);
  });
  it("is case-insensitive on the email", async () => {
    const id = "00000000-0000-0000-0000-0000000000d2";
    await addUser(id, "Teacher@LECFL.Com");
    expect((await join(id))[0]!.r).toBe(ORG);
  });
  it.each(["x@evil-lecfl.com", "x@lecfl.com.evil.org", "x@mail.lecfl.com", "x@lecfl.co", "x@gmail.com", "x@y@lecfl.com"])(
    "%s does not join",
    async (email) => {
      const id = crypto.randomUUID();
      await addUser(id, email);
      expect((await join(id))[0]!.r).toBeNull();
      expect(await members(id)).toHaveLength(0);
    },
  );
  it("an unverified email never joins", async () => {
    const id = crypto.randomUUID();
    await addUser(id, "unverified@lecfl.com", false);
    expect((await join(id))[0]!.r).toBeNull();
  });
  it("a listed subdomain matches only itself", async () => {
    await setOrg("invite_or_domain", ["mail.lecfl.com"]);
    const sub = crypto.randomUUID();
    const root = crypto.randomUUID();
    await addUser(sub, "a@mail.lecfl.com");
    await addUser(root, "a@lecfl.com");
    expect((await join(sub))[0]!.r).toBe(ORG);
    expect((await join(root))[0]!.r).toBeNull();
    await setOrg("invite_or_domain", ["lecfl.com"]);
  });
  it("never re-adds a member an admin disabled, and never changes an existing role", async () => {
    await db.admin(`update organization_members set status='disabled' where user_id=$1`, [T1]);
    expect((await join(T1))[0]!.r).toBeNull();
    expect(await members(T1)).toEqual([{ role: "student", status: "disabled" }]);
    expect((await join(ADMIN))[0]!.r).toBeNull();
    expect((await members(ADMIN))[0]!.role).toBe("org_admin");
  });
  it("is not callable by anon or signed-in users (service role only)", async () => {
    await expect(db.as("anon", null, `select public.join_org_by_domain($1)`, [STRANGER])).rejects.toThrow(/permission denied/i);
    await expect(db.as("authenticated", STRANGER, `select public.join_org_by_domain($1)`, [STRANGER])).rejects.toThrow(/permission denied/i);
  });
});

describe("a signed-up outsider has an auth account but zero org access", () => {
  it("cannot insert themselves into an org (RLS), nor read org data", async () => {
    await expect(
      db.as("authenticated", STRANGER, `insert into organization_members (user_id, organization_id, role) values ($1,$2,'org_admin')`, [STRANGER, ORG]),
    ).rejects.toThrow(/row-level security/i);
    const tables = [
      "organizations", "organization_members", "organization_settings", "organization_invitations", "print_jobs",
      "printers", "printer_profiles", "agents", "audit_logs", "groups", "group_members", "quotas", "monthly_usage",
      "print_job_events", "approval_actions", "remote_commands", "member_devices", "device_events", "device_issues",
      "print_policies", "policy_rules",
    ];
    for (const t of tables) {
      const rows = await db.as("authenticated", STRANGER, `select * from public.${t}`).catch(() => []);
      expect(rows, t).toHaveLength(0);
    }
    const profiles = await db.as<{ id: string }>("authenticated", STRANGER, `select id from profiles`);
    expect(profiles.map((p) => p.id)).toEqual([STRANGER]);
  });
  it("cannot flip org settings, create invitations, or reach storage", async () => {
    const upd = await db.as("authenticated", STRANGER, `update organizations set join_mode='invite_or_domain' where id=$1 returning id`, [ORG]);
    expect(upd).toHaveLength(0);
    await expect(
      db.as(
        "authenticated",
        STRANGER,
        `insert into organization_invitations (organization_id, code, role, created_by) values ($1,'abcdef123456','org_admin',$2)`,
        [ORG, STRANGER],
      ),
    ).rejects.toThrow();
    expect(await db.as("authenticated", STRANGER, `select * from storage.objects`)).toHaveLength(0);
  });
  it("anon reads nothing", async () => {
    const rows = await db.as("anon", null, `select * from organizations`).catch(() => []);
    expect(rows).toHaveLength(0);
  });
});
