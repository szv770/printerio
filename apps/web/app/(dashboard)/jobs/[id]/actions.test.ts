import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const session = { userId: "u1", membership: { organization_id: "org1", role: "staff" } };
let hasMembership = true;
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: async () => ({ ...session, membership: hasMembership ? session.membership : null }) }));

// The member client must never be used for a write; any call on it is recorded and fails the test.
const memberCalls: string[] = [];
const member = { from: (t: string) => (memberCalls.push(t), { select: () => ({}) }) };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => member }));
const service = { marker: "service-role-client" };
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => service }));

const cancelOwnJob = vi.fn();
const retryOwnJob = vi.fn();
vi.mock("@/lib/jobs/lifecycle", () => ({
  cancelOwnJob: (...a: unknown[]) => cancelOwnJob(...a),
  retryOwnJob: (...a: unknown[]) => retryOwnJob(...a),
}));

import { cancelJobAction, retryJobAction } from "./actions";

const fd = (extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set("jobId", "j1");
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};

beforeEach(() => {
  hasMembership = true;
  memberCalls.length = 0;
  cancelOwnJob.mockReset();
  retryOwnJob.mockReset();
});

describe("cancelJobAction", () => {
  it("cancels with the SERVICE-ROLE client, scoped to the session user and org (form fields cannot override them)", async () => {
    cancelOwnJob.mockResolvedValue({ ok: true, message: "Cancelled." });
    const out = await cancelJobAction({}, fd({ userId: "victim", organizationId: "org9" }));
    expect(out).toEqual({ success: "Cancelled." });
    expect(cancelOwnJob).toHaveBeenCalledWith(service, { jobId: "j1", userId: "u1", organizationId: "org1" });
    expect(memberCalls).toEqual([]);
  });

  it("passes the plain 'already gone to the printer' message straight through", async () => {
    cancelOwnJob.mockResolvedValue({ ok: false, error: "This job has already gone to the printer. Clear it at the printer." });
    expect(await cancelJobAction({}, fd())).toEqual({ error: "This job has already gone to the printer. Clear it at the printer." });
  });

  it("refuses a missing job id or a user with no organization without writing", async () => {
    expect(await cancelJobAction({}, new FormData())).toMatchObject({ error: expect.any(String) });
    hasMembership = false;
    expect(await cancelJobAction({}, fd())).toMatchObject({ error: expect.any(String) });
    expect(cancelOwnJob).not.toHaveBeenCalled();
  });

  it("turns an unexpected failure into a plain message, never the raw error", async () => {
    cancelOwnJob.mockRejectedValue(new Error('relation "print_jobs" exploded'));
    const out = await cancelJobAction({}, fd());
    expect(out.error).toBeTruthy();
    expect(out.error).not.toMatch(/relation|exploded/);
  });
});

describe("retryJobAction", () => {
  it("re-queues with the service-role client for the session user", async () => {
    retryOwnJob.mockResolvedValue({ ok: true, message: "Queued again." });
    expect(await retryJobAction({}, fd())).toEqual({ success: "Queued again." });
    expect(retryOwnJob).toHaveBeenCalledWith(service, { jobId: "j1", userId: "u1", organizationId: "org1" });
    expect(memberCalls).toEqual([]);
  });

  it("reports a refusal inline", async () => {
    retryOwnJob.mockResolvedValue({ ok: false, error: "No retries left." });
    expect(await retryJobAction({}, fd())).toEqual({ error: "No retries left." });
  });
});
