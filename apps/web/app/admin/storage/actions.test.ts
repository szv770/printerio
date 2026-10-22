import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let allowed = true;
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async () => {
    if (!allowed) throw new Error("FORBIDDEN");
    return { userId: "admin-1", membership: { organization_id: "org1", role: "org_admin" } };
  },
}));
const memberCalls: string[] = [];
const member = { from: (t: string) => ({ insert: async () => (memberCalls.push(`insert:${t}`), { error: null }) }) };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => member }));
const service = { marker: "service" };
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => service }));
const sweepRetention = vi.fn();
vi.mock("@/lib/retention", () => ({ sweepRetention: (...a: unknown[]) => sweepRetention(...a) }));

import { runStorageCleanupAction } from "./actions";

beforeEach(() => {
  allowed = true;
  memberCalls.length = 0;
  sweepRetention.mockReset().mockResolvedValue({ filesDeleted: 2, jobsPurged: 1 });
});

describe("runStorageCleanupAction", () => {
  it("runs the purge with the service-role client, scoped to the caller's own organization", async () => {
    await runStorageCleanupAction({}, new FormData());
    const [client, opts] = sweepRetention.mock.calls[0]!;
    expect(client).toBe(service);
    expect(opts).toMatchObject({ organizationId: "org1" });
  });

  it("is org_admin only", async () => {
    allowed = false;
    await expect(runStorageCleanupAction({}, new FormData())).rejects.toThrow("FORBIDDEN");
    expect(sweepRetention).not.toHaveBeenCalled();
  });
});
