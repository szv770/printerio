import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-auth", () => ({ authenticateAgentRequest: async () => ({ id: "agent1", organizationId: "org1", paused: false }) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

type Row = Record<string, unknown>;
let commands: Row[];
let audits: Row[];
let lastOr: string | null;
let failMark = false;

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "update" | "insert" = "select";
  let patch: Row = {};
  let inserted: Row[] = [];
  const q: Record<string, unknown> = {
    select: () => q,
    update: (p: Row) => ((mode = "update"), (patch = p), q),
    insert: (rows: Row | Row[]) => ((mode = "insert"), (inserted = Array.isArray(rows) ? rows : [rows]), q),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
    or: (expr: string) => {
      lastOr = expr;
      const m = /created_at\.lt\.([^)]+)\)/.exec(expr);
      filters.push((r) => r.status === "pending" || (r.status === "acknowledged" && !!m && Date.parse(r.created_at as string) < Date.parse(m[1]!)));
      return q;
    },
    order: () => q,
    maybeSingle: () => Promise.resolve({ data: commands.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => {
      if (table === "audit_logs") {
        if (mode === "insert") audits.push(...inserted);
        return resolve({ data: null, error: null });
      }
      const matched = commands.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        if (failMark) return resolve({ data: null, error: { message: "boom" } });
        for (const r of matched) Object.assign(r, patch);
        return resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
      }
      resolve({ data: matched.map((r) => ({ ...r })), error: null });
    },
  };
  return q;
}
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => ({ from: (t: string) => builder(t) }) }));

import { GET } from "./route";
import { POST as ack } from "./[commandId]/ack/route";

const cmd = (id: string, status: string, ageMin = 0, over: Row = {}): Row => ({
  id, agent_id: "agent1", organization_id: "org1", command: "CHECK_FOR_UPDATE", payload: {}, status,
  created_at: new Date(Date.now() - ageMin * 60_000).toISOString(), ...over,
});
const post = (id: string, body: unknown) =>
  ack(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ commandId: id }) });

beforeEach(() => {
  commands = [];
  audits = [];
  lastOr = null;
  failMark = false;
});

describe("GET /api/agents/commands", () => {
  it("hands out pending commands (id, command, payload only) and marks them picked up so the page can say Running...", async () => {
    commands = [cmd("c1", "pending")];
    const body = await (await GET(new Request("http://x"))).json();
    expect(body.commands).toEqual([{ id: "c1", command: "CHECK_FOR_UPDATE", payload: {} }]);
    expect(commands[0]!.status).toBe("acknowledged");
  });

  it("does not hand the same command out again on the next poll while it is being worked on", async () => {
    commands = [cmd("c1", "pending")];
    await GET(new Request("http://x"));
    const again = await (await GET(new Request("http://x"))).json();
    expect(again.commands).toEqual([]);
  });

  it("re-offers a command that was picked up but never answered for 15+ minutes (the Agent crashed)", async () => {
    commands = [cmd("old", "acknowledged", 30), cmd("fresh", "acknowledged", 2)];
    const body = await (await GET(new Request("http://x"))).json();
    expect(body.commands.map((c: { id: string }) => c.id)).toEqual(["old"]);
    expect(lastOr).toContain("status.eq.pending");
  });

  it("still returns the work when marking it as picked up fails", async () => {
    commands = [cmd("c1", "pending")];
    failMark = true;
    const res = await GET(new Request("http://x"));
    expect(res.status).toBe(200);
    expect((await res.json()).commands).toHaveLength(1);
  });
});

describe("POST /api/agents/commands/[id]/ack", () => {
  it("records the result and audits it", async () => {
    commands = [cmd("c1", "acknowledged")];
    const res = await post("c1", { status: "completed", result: { message: "Updated a -> b." } });
    expect(res.status).toBe(200);
    expect(commands[0]).toMatchObject({ status: "completed", result: { message: "Updated a -> b." } });
    expect(audits[0]).toMatchObject({ action: "remote_command.acknowledged", metadata: { command: "CHECK_FOR_UPDATE", status: "completed" } });
  });

  it("never copies GET_LOGS content into audit_logs, but stores it in the command row for the admin", async () => {
    commands = [cmd("c1", "acknowledged", 0, { command: "GET_LOGS" })];
    const result = { files: [{ name: "agent/a.log", lines: ["private line one", "two"] }], notes: [] };
    await post("c1", { status: "completed", result });
    expect(JSON.stringify(audits)).not.toContain("private line");
    expect(audits[0]!.metadata).toMatchObject({ result: { files: 1, lines: 2 } });
    expect(commands[0]!.result).toEqual(result);
  });

  it("an answered command keeps its first answer; a repeated ack changes and audits nothing", async () => {
    commands = [cmd("c1", "completed", 0, { result: { message: "first" } })];
    const res = await post("c1", { status: "failed", result: { message: "second" } });
    expect(res.status).toBe(200);
    expect(commands[0]).toMatchObject({ status: "completed", result: { message: "first" } });
    expect(audits).toHaveLength(0);
  });

  it("refuses another agent's command, a bad status, a non-object result and an oversized result", async () => {
    commands = [cmd("c1", "acknowledged", 0, { agent_id: "other" })];
    expect((await post("c1", { status: "completed" })).status).toBe(404);
    commands = [cmd("c2", "acknowledged")];
    expect((await post("c2", { status: "weird" })).status).toBe(400);
    expect((await post("c2", { status: "completed", result: "text" })).status).toBe(400);
    expect((await post("c2", { status: "completed", result: { blob: "x".repeat(300_000) } })).status).toBe(413);
    expect(commands[0]!.status).toBe("acknowledged");
  });
  it("a progress report updates the live result without finishing the command or auditing it", async () => {
    commands = [cmd("c1", "acknowledged")];
    const res = await post("c1", { status: "progress", result: { step: "downloading", message: "Downloading" } });
    expect(res.status).toBe(200);
    expect(commands[0]).toMatchObject({ status: "acknowledged", result: { step: "downloading" } });
    expect(commands[0]!.completed_at).toBeUndefined();
    expect(audits).toHaveLength(0);
  });

  it("a late progress report can never overwrite a finished answer", async () => {
    commands = [cmd("c1", "completed", 0, { result: { message: "final" } })];
    const res = await post("c1", { status: "progress", result: { step: "installing" } });
    expect(res.status).toBe(200);
    expect(commands[0]).toMatchObject({ status: "completed", result: { message: "final" } });
  });

  it("progress needs an object result and belongs to the calling agent only", async () => {
    commands = [cmd("c1", "acknowledged")];
    expect((await post("c1", { status: "progress" })).status).toBe(400);
    commands = [cmd("c2", "acknowledged", 0, { agent_id: "other" })];
    expect((await post("c2", { status: "progress", result: { step: "installing" } })).status).toBe(404);
  });
});
