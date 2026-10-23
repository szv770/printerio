import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let role: string | null = "org_admin";
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async (roles: string[]) => {
    if (!role || !roles.includes(role)) throw new Error("FORBIDDEN");
    return { userId: "admin-1", membership: { organization_id: "org1", role } };
  },
}));
let agentVersion: string | null = "0.2.0";
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { version: agentVersion } }) }) }) }),
  }),
}));
const issue = vi.fn(async (..._a: unknown[]) => ({ ok: true, commandId: "c1" }) as { ok: true; commandId: string } | { ok: false; error: string });
vi.mock("@/lib/remote-commands", () => ({ issueRemoteCommand: (...a: unknown[]) => issue(...a) }));

import { getAgentLogsAction, checkAgentForUpdateAction, checkAgentUpdateAvailableAction } from "./actions";

const form = (agentId = "agent1") => {
  const f = new FormData();
  f.set("agentId", agentId);
  return f;
};

beforeEach(() => {
  role = "org_admin";
  agentVersion = "0.2.0";
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

describe("checkAgentUpdateAvailableAction", () => {
  it("issues CHECK_FOR_UPDATE with only the fixed check_only mode, admin only, ignoring form extras", async () => {
    const f = form();
    f.set("mode", "pull --force");
    const r = await checkAgentUpdateAvailableAction({}, f);
    expect(r).toEqual({});
    expect(issue.mock.calls[0]![1]).toEqual({ organizationId: "org1", issuedBy: "admin-1", agentId: "agent1", command: "CHECK_FOR_UPDATE", payload: { mode: "check_only" } });
    role = "member";
    await expect(checkAgentUpdateAvailableAction({}, form())).rejects.toThrow("FORBIDDEN");
  });
});

describe("checkAgentUpdateAvailableAction - old agents", () => {
  it("refuses to send check_only to an agent that has not reported support, so an old agent can never start a full update by itself", async () => {
    for (const v of ["0.1.0", null]) {
      agentVersion = v;
      const r = await checkAgentUpdateAvailableAction({}, form());
      expect(r.error).toBeTruthy();
    }
    expect(issue).not.toHaveBeenCalled();
  });
});
