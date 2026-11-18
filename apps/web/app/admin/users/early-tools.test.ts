import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok, type FakeCall, type FakeResult } from "@/test/fake-supabase";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const ACTOR = "admin-1";
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async () => ({ userId: ACTOR, membership: { organization_id: "org-1", role: "org_admin" } }),
}));
let fake: ReturnType<typeof fakeSupabase>;
let respond: (c: FakeCall) => FakeResult;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));

import { setMemberEarlyToolsAction } from "./actions";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const updates = () => fake.calls.filter((c) => c.table === "organization_members" && c.op === "update");
const audits = () => fake.calls.filter((c) => c.table === "audit_logs");

beforeEach(() => {
  respond = () => ok();
  fake = fakeSupabase((c) => respond(c));
});

describe("setMemberEarlyToolsAction", () => {
  it("switches early tools on for a member, scoped to the admin's own organization, and logs it", async () => {
    expect(await setMemberEarlyToolsAction({}, fd({ userId: "u2", enabled: "true" }))).toEqual({});
    expect(updates()).toHaveLength(1);
    expect(updates()[0]!.values).toEqual({ early_tools: true });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]!.values).toMatchObject({ organization_id: "org-1", actor_id: ACTOR, action: "member.early_tools_changed", target_id: "u2" });
  });

  it("switches it off", async () => {
    expect(await setMemberEarlyToolsAction({}, fd({ userId: "u2", enabled: "false" }))).toEqual({});
    expect(updates()[0]!.values).toEqual({ early_tools: false });
  });

  it("rejects a missing person or a value that is not true/false, writing nothing", async () => {
    expect((await setMemberEarlyToolsAction({}, fd({ userId: "", enabled: "true" }))).error).toBeTruthy();
    expect((await setMemberEarlyToolsAction({}, fd({ userId: "u2", enabled: "maybe" }))).error).toBeTruthy();
    expect(updates()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it("reports a database failure plainly and does not log a change that did not happen", async () => {
    respond = (c) => (c.op === "update" ? { data: null, error: { message: "boom", code: "XX000" } } : ok());
    const res = await setMemberEarlyToolsAction({}, fd({ userId: "u2", enabled: "true" }));
    expect(res.error).toBeTruthy();
    expect(audits()).toHaveLength(0);
  });
});
