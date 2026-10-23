import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let role: string | null = "org_admin";
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async (roles: string[]) => {
    if (!role || !roles.includes(role)) throw new Error("FORBIDDEN");
    return { userId: "admin-1", membership: { organization_id: "org1", role } };
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
const issue = vi.fn(async (..._a: unknown[]) => ({ ok: true, commandId: "c1" }) as { ok: true; commandId: string } | { ok: false; error: string });
vi.mock("@/lib/remote-commands", () => ({ issueRemoteCommand: (...a: unknown[]) => issue(...a) }));

import { getAgentLogsAction, checkAgentForUpdateAction } from "./actions";

const form = (agentId = "agent1") => {
  const f = new FormData();
  f.set("agentId", agentId);
  return f;
};

beforeEach(() => {
  role = "org_admin";
  issue.mockClear();
  issue.mockResolvedValue({ ok: true, commandId: "c1" });
});

describe("getAgentLogsAction", () => {
  it("issues exactly the fixed GET_LOGS command for the session's own organization, with no payload", async () => {
    const r = await getAgentLogsAction({}, form());
    expect(r).toEqual({});
    expect(issue).toHaveBeenCalledTimes(1);
    expect(issue.mock.calls[0]![1]).toEqual({ organizationId: "org1", issuedBy: "admin-1", agentId: "agent1", command: "GET_LOGS" });
  });

  it("ignores any extra form fields (nothing from the form can become a payload)", async () => {
    const f = form();
    f.set("path", "C:\\Windows\\win.ini");
    f.set("payload", "{\"x\":1}");
    await getAgentLogsAction({}, f);
    expect(issue.mock.calls[0]![1]).not.toHaveProperty("payload");
  });

  it("is admin only: an approver is refused before anything is issued", async () => {
    role = "approver";
    await expect(getAgentLogsAction({}, form())).rejects.toThrow("FORBIDDEN");
    role = "member";
    await expect(getAgentLogsAction({}, form())).rejects.toThrow("FORBIDDEN");
    expect(issue).not.toHaveBeenCalled();
  });

  it("passes the 'not available yet' explanation through to the page instead of failing silently", async () => {
    issue.mockResolvedValue({ ok: false, error: "That request is not available yet: ..." });
    const r = await getAgentLogsAction({}, form());
    expect(r.error).toMatch(/not available yet/);
  });
});

describe("checkAgentForUpdateAction", () => {
  it("is still the payload-free CHECK_FOR_UPDATE, admin only", async () => {
    await checkAgentForUpdateAction({}, form());
    expect(issue.mock.calls[0]![1]).toEqual({ organizationId: "org1", issuedBy: "admin-1", agentId: "agent1", command: "CHECK_FOR_UPDATE" });
    role = "approver";
    await expect(checkAgentForUpdateAction({}, form())).rejects.toThrow("FORBIDDEN");
  });
});
