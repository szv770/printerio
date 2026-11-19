import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, ok } from "@/test/fake-supabase";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let role: string | null = "org_admin";
vi.mock("@/lib/auth/session", () => ({
  requireOrgRole: async (roles: string[]) => {
    if (!role || !roles.includes(role)) throw new Error("FORBIDDEN");
    return { userId: "admin-1", membership: { organization_id: "org1", role } };
  },
}));
let agentVersion: string | null = "0.2.0";
// What the remote_commands lookups answer: rows for the "is an update already open?" check, and whether a cancel hits a pending row.
let openRows: Array<Record<string, unknown>> = [];
let cancelHit = true;
let fake: ReturnType<typeof fakeSupabase>;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
const issue = vi.fn(async (..._a: unknown[]) => ({ ok: true, commandId: "c1" }) as { ok: true; commandId: string } | { ok: false; error: string });
vi.mock("@/lib/remote-commands", () => ({ issueRemoteCommand: (...a: unknown[]) => issue(...a) }));

import { getAgentLogsAction, checkAgentForUpdateAction, checkAgentUpdateAvailableAction, cancelPendingUpdateAction } from "./actions";

const form = (agentId = "agent1") => {
  const f = new FormData();
  f.set("agentId", agentId);
  return f;
};

beforeEach(() => {
  role = "org_admin";
  agentVersion = "0.2.0";
  openRows = [];
  cancelHit = true;
  fake = fakeSupabase((c) => {
    if (c.table === "agents") return ok({ version: agentVersion });
    if (c.table === "remote_commands" && c.op === "select") return ok(openRows);
    if (c.table === "remote_commands" && c.op === "update") return ok(cancelHit ? { id: "cmd-1" } : null);
    return ok();
  });
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

describe("checkAgentForUpdateAction: no duplicate updates", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  it("does not insert a second full update while one is pending", async () => {
    openRows = [{ id: "p1", status: "pending", payload: {}, created_at: minutesAgo(30) }];
    const r = await checkAgentForUpdateAction({}, form());
    expect(r.error).toMatch(/already waiting or running/);
    expect(issue).not.toHaveBeenCalled();
  });

  it("does not insert one while one is acknowledged (running)", async () => {
    openRows = [{ id: "a1", status: "acknowledged", payload: {}, created_at: minutesAgo(2) }];
    const r = await checkAgentForUpdateAction({}, form());
    expect(r.error).toMatch(/already waiting or running/);
    expect(issue).not.toHaveBeenCalled();
  });

  it("a look-only check, or a long-stuck acknowledged row, does not block a new update", async () => {
    openRows = [
      { id: "c1", status: "pending", payload: { mode: "check_only" }, created_at: minutesAgo(1) },
      { id: "a1", status: "acknowledged", payload: {}, created_at: minutesAgo(60) },
    ];
    const r = await checkAgentForUpdateAction({}, form());
    expect(r).toEqual({});
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("only looks at this school's rows for this server", async () => {
    await checkAgentForUpdateAction({}, form("agent9"));
    const lookup = fake.calls.find((c) => c.table === "remote_commands" && c.op === "select")!;
    expect(lookup.filters).toEqual(expect.arrayContaining([["eq", "organization_id", "org1"], ["eq", "agent_id", "agent9"]]));
  });
});

describe("cancelPendingUpdateAction", () => {
  const cancelForm = () => {
    const f = form("agent1");
    f.set("commandId", "cmd-1");
    return f;
  };
  const update = () => fake.calls.find((c) => c.table === "remote_commands" && c.op === "update")!;

  it("cancels only a pending update of the admin's own school, marking it failed with the result 'cancelled'", async () => {
    const r = await cancelPendingUpdateAction({}, cancelForm());
    expect(r).toEqual({});
    expect(update().values).toMatchObject({ status: "failed", result: { message: "cancelled" } });
    expect(update().filters).toEqual(
      expect.arrayContaining([["eq", "id", "cmd-1"], ["eq", "organization_id", "org1"], ["eq", "agent_id", "agent1"], ["eq", "command", "CHECK_FOR_UPDATE"], ["eq", "status", "pending"]]),
    );
  });

  it("refuses an acknowledged (running) or already finished command: the pending-only update matches no row and says so", async () => {
    cancelHit = false;
    const r = await cancelPendingUpdateAction({}, cancelForm());
    expect(r.error).toMatch(/can no longer be cancelled/);
    // the only write attempted is conditional on status = pending, so a running command can never be changed
    expect(update().filters).toEqual(expect.arrayContaining([["eq", "status", "pending"]]));
  });

  it("is admin only", async () => {
    role = "approver";
    await expect(cancelPendingUpdateAction({}, cancelForm())).rejects.toThrow("FORBIDDEN");
    expect(fake.calls.filter((c) => c.op === "update")).toHaveLength(0);
  });
});
