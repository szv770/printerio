import { describe, expect, it } from "vitest";
import { issueRemoteCommand } from "./remote-commands";

type Row = Record<string, unknown>;

function fakeClient(opts: { insertError?: { code?: string; message?: string } | null } = {}) {
  const audits: Row[] = [];
  const inserts: Row[] = [];
  const client = {
    from(table: string) {
      if (table === "agents") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "a1", organization_id: "org1" } }) }) }) };
      }
      if (table === "remote_commands") {
        return {
          insert: (row: Row) => {
            inserts.push(row);
            return { select: () => ({ single: async () => (opts.insertError ? { data: null, error: opts.insertError } : { data: { id: "cmd1" }, error: null }) }) };
          },
        };
      }
      return { insert: async (row: Row) => (audits.push(row), { error: null }) };
    },
  };
  return { client: client as never, audits, inserts };
}

const params = { organizationId: "org1", issuedBy: "u1", agentId: "a1" };

describe("issueRemoteCommand with GET_LOGS", () => {
  it("accepts the fixed GET_LOGS command with an empty payload and audits who asked", async () => {
    const { client, audits, inserts } = fakeClient();
    const r = await issueRemoteCommand(client, { ...params, command: "GET_LOGS" });
    expect(r).toEqual({ ok: true, commandId: "cmd1" });
    expect(inserts[0]).toMatchObject({ command: "GET_LOGS", payload: {}, issued_by: "u1" });
    expect(audits[0]).toMatchObject({ action: "remote_command.issued", actor_id: "u1", metadata: { command: "GET_LOGS", agentId: "a1" } });
  });

  it("refuses a command name that is not on the allow-list", async () => {
    const { client, inserts } = fakeClient();
    const r = await issueRemoteCommand(client, { ...params, command: "RUN_POWERSHELL" });
    expect(r.ok).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it("before migration 0036 is applied the database rejects it, and the admin is told it is not available yet", async () => {
    const { client, audits } = fakeClient({ insertError: { code: "23514", message: 'violates check constraint "remote_commands_command_check"' } });
    const r = await issueRemoteCommand(client, { ...params, command: "GET_LOGS" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/not available yet/i);
    expect(r.ok === false && r.error).toMatch(/0036/);
    expect(audits).toHaveLength(0);
  });

  it("any other database error stays a generic failure", async () => {
    const { client } = fakeClient({ insertError: { code: "XX000" } });
    const r = await issueRemoteCommand(client, { ...params, command: "GET_LOGS" });
    expect(r).toEqual({ ok: false, error: "Failed to issue command." });
  });
});
