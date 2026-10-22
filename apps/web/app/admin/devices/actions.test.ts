import { beforeEach, describe, expect, it, vi } from "vitest";

class Forbidden extends Error {}
let role: "org_admin" | "approver" | "staff" | null = "org_admin";
const session = { userId: "a1", membership: { organization_id: "org1" } };
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async (roles: string[]) => {
    if (!role || !roles.includes(role)) throw new Forbidden("forbidden");
    return session;
  },
}));
const supabase = { marker: "admin-client" };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const revokeDevice = vi.fn();
const resolveIssue = vi.fn();
vi.mock("@/lib/devices/devices", () => ({
  revokeDevice: (...a: unknown[]) => revokeDevice(...a),
  resolveIssue: (...a: unknown[]) => resolveIssue(...a),
}));

import { adminRevokeDeviceAction, resolveIssueAction } from "./actions";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

beforeEach(() => {
  revokeDevice.mockReset();
  resolveIssue.mockReset();
  role = "org_admin";
});

describe("adminRevokeDeviceAction", () => {
  it.each(["approver", "staff", null] as const)("is admin only (%s is refused)", async (r) => {
    role = r;
    await expect(adminRevokeDeviceAction({}, fd({ deviceId: "d1" }))).rejects.toThrow();
    expect(revokeDevice).not.toHaveBeenCalled();
  });
  it("revokes asAdmin within the admin's organization", async () => {
    revokeDevice.mockResolvedValue({ ok: true });
    const res = await adminRevokeDeviceAction({}, fd({ deviceId: "d1" }));
    expect(revokeDevice).toHaveBeenCalledWith(supabase, { deviceId: "d1", organizationId: "org1", userId: "a1", asAdmin: true });
    expect(res).toEqual({ revokedId: "d1" });
  });
  it("requires a device id and returns errors inline", async () => {
    expect((await adminRevokeDeviceAction({}, fd({}))).error).toBeTruthy();
    revokeDevice.mockResolvedValue({ ok: false, error: "Device not found." });
    expect(await adminRevokeDeviceAction({}, fd({ deviceId: "d1" }))).toEqual({ error: "Device not found." });
  });
});

describe("resolveIssueAction", () => {
  it("is admin only", async () => {
    role = "approver";
    await expect(resolveIssueAction({}, fd({ issueId: "i1", note: "x" }))).rejects.toThrow();
    expect(resolveIssue).not.toHaveBeenCalled();
  });
  it("resolves with the admin's id and org", async () => {
    resolveIssue.mockResolvedValue({ ok: true });
    const res = await resolveIssueAction({}, fd({ issueId: "i1", note: "Re-added it" }));
    expect(resolveIssue).toHaveBeenCalledWith(supabase, { issueId: "i1", adminId: "a1", organizationId: "org1", note: "Re-added it" });
    expect(res).toEqual({ resolvedId: "i1" });
  });
  it("requires an issue id and shows errors inline", async () => {
    expect((await resolveIssueAction({}, fd({ note: "x" }))).error).toBeTruthy();
    resolveIssue.mockResolvedValue({ ok: false, error: "Too long." });
    expect(await resolveIssueAction({}, fd({ issueId: "i1", note: "x" }))).toEqual({ error: "Too long." });
  });
});
