import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok, type FakeResult, type FakeCall } from "@/test/fake-supabase";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async () => ({ userId: "admin-1", membership: { organization_id: "org-1", role: "org_admin" } }),
}));
let fake: ReturnType<typeof fakeSupabase>;
let respond: (c: FakeCall) => FakeResult;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
const service = {};
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => service }));
const cancelMemberQueue = vi.fn(async (..._a: unknown[]) => ({ cancelled: 4, skipped: 1, more: false }));
vi.mock("@/lib/jobs/lifecycle", () => ({ cancelMemberQueue: (...a: unknown[]) => cancelMemberQueue(...a) }));

import { cancelMemberQueueAction } from "./actions";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const audits = () => fake.calls.filter((c) => c.table === "audit_logs");

beforeEach(() => {
  cancelMemberQueue.mockClear();
  respond = () => ok();
  fake = fakeSupabase((c) => respond(c));
});

describe("cancelMemberQueueAction", () => {
  it("cancels the person's waiting jobs inside the admin's own organization, and logs it", async () => {
    const res = await cancelMemberQueueAction({}, fd({ userId: "u2" }));
    expect(res).toMatchObject({ message: expect.stringMatching(/cancelled 4/i) });
    expect(cancelMemberQueue).toHaveBeenCalledWith(service, { organizationId: "org-1", adminId: "admin-1", userId: "u2" });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]!.values).toMatchObject({ organization_id: "org-1", actor_id: "admin-1", action: "member.queue_cancelled", target_id: "u2" });
  });

  it("says when there is more to cancel, so the admin presses again", async () => {
    cancelMemberQueue.mockResolvedValueOnce({ cancelled: 200, skipped: 0, more: true });
    expect(await cancelMemberQueueAction({}, fd({ userId: "u2" }))).toMatchObject({ message: expect.stringMatching(/press .* again/i) });
  });

  it("rejects a missing person without doing anything", async () => {
    expect((await cancelMemberQueueAction({}, fd({ userId: "" }))).error).toBeTruthy();
    expect(cancelMemberQueue).not.toHaveBeenCalled();
  });
});
