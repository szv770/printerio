import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok, type FakeCall } from "@/test/fake-supabase";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async () => ({ userId: "admin-1", membership: { organization_id: "org-1", role: "org_admin" } }),
}));
let fake: ReturnType<typeof fakeSupabase>;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));

import { changeMemberDepartmentAction, changeMemberUserCodeAction, createInvitationAction } from "./actions";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const audits = () => fake.calls.filter((c) => c.table === "audit_logs").map((c) => c.values as { action: string; target_id: string | null; metadata: Record<string, unknown> });

beforeEach(() => {
  fake = fakeSupabase((c: FakeCall) => (c.table === "organization_invitations" ? ok({ id: "inv-1" }) : ok()));
});

describe("audit rows for changes that used to be silent", () => {
  it("section change", async () => {
    await changeMemberDepartmentAction({}, fd({ userId: "u1", department: " Art " }));
    expect(audits()).toEqual([expect.objectContaining({ action: "member.section_changed", target_id: "u1", metadata: { section: "Art" } })]);
  });
  it("print code change", async () => {
    await changeMemberUserCodeAction({}, fd({ userId: "u1", userCode: "ab12" }));
    expect(audits()[0]).toMatchObject({ action: "member.print_code_changed", target_id: "u1" });
  });
  it("no audit row when the change fails", async () => {
    fake = fakeSupabase(() => ({ data: null, error: { message: "x" } }));
    await changeMemberDepartmentAction({}, fd({ userId: "u1", department: "Art" }));
    expect(audits()).toHaveLength(0);
  });
  it("invite creation, without writing the secret code", async () => {
    const res = await createInvitationAction({}, fd({ role: "staff", maxUses: "5" }));
    expect(res.code).toBeTruthy();
    const a = audits()[0]!;
    expect(a).toMatchObject({ action: "invitation.created", target_id: "inv-1" });
    expect(JSON.stringify(a.metadata)).not.toContain(res.code!);
  });
});
