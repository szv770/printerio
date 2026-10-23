import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgRole = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", () => ({ requireOrgRole: (...a: unknown[]) => requireOrgRole(...a) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => ({ svc: true }) }));
const removeUnmatchedSignup = vi.fn();
vi.mock("@/lib/admin/unmatched-signups", () => ({ removeUnmatchedSignup: (...a: unknown[]) => removeUnmatchedSignup(...a) }));

import { removeSignupAction } from "./actions";

const fd = (id: string) => {
  const f = new FormData();
  f.set("userId", id);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  removeUnmatchedSignup.mockResolvedValue({ ok: true });
});

describe("removeSignupAction", () => {
  it("requires org_admin and passes the ADMIN'S OWN org and id (never form values)", async () => {
    requireOrgRole.mockResolvedValue({ userId: "adm", membership: { organization_id: "org-9" } });
    const r = await removeSignupAction({}, fd("u1"));
    expect(requireOrgRole).toHaveBeenCalledWith(["org_admin"]);
    expect(removeUnmatchedSignup).toHaveBeenCalledWith({ svc: true }, { actorId: "adm", organizationId: "org-9", targetId: "u1" });
    expect(r).toEqual({ success: expect.any(String) });
  });
  it("a non-admin is rejected before anything runs", async () => {
    requireOrgRole.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(removeSignupAction({}, fd("u1"))).rejects.toThrow();
    expect(removeUnmatchedSignup).not.toHaveBeenCalled();
  });
  it("returns the refusal message", async () => {
    requireOrgRole.mockResolvedValue({ userId: "adm", membership: { organization_id: "o" } });
    removeUnmatchedSignup.mockResolvedValue({ ok: false, error: "nope" });
    expect(await removeSignupAction({}, fd("u1"))).toEqual({ error: "nope" });
  });
  it("rejects a missing/garbage id without calling the service", async () => {
    requireOrgRole.mockResolvedValue({ userId: "adm", membership: { organization_id: "o" } });
    expect((await removeSignupAction({}, fd(""))).error).toBeTruthy();
    expect(removeUnmatchedSignup).not.toHaveBeenCalled();
  });
});
