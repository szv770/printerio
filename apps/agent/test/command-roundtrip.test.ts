/**
 * Full remote-command round trip, exercised across the same seam the real
 * system uses: a fake cloud that speaks the exact `docs/agent-api.md` wire
 * contract (GET /api/agents/commands -> handler -> POST
 * /api/agents/commands/:id/ack), driving the real CloudClient and the real
 * command handler.
 *
 * The existing test/commands.test.ts proves each handler branch in isolation.
 * What it can't prove - and what a "does the Restart queue button actually do
 * anything?" question is really asking - is that a command issued by the
 * console is picked up over the wire, executed, and ACKNOWLEDGED BACK with a
 * result the console can show. That whole loop is what's tested here.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REMOTE_COMMANDS } from "@printio/shared";
import { CloudClient, type RemoteCommandEnvelope } from "../src/cloud-client.js";
import { handleCommand, type CommandHandlerDeps } from "../src/commands.js";
import { createJobQueue } from "../src/job-queue.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });

interface StoredCommand {
  id: string;
  command: string;
  payload: Record<string, unknown>;
  status: "pending" | "completed" | "failed";
  result: Record<string, unknown> | null;
}

/**
 * An in-memory stand-in for the `remote_commands` table plus the two route
 * handlers over it, matching their real shapes (app/api/agents/commands and
 * .../[commandId]/ack): pending rows are listed, an ack flips status and
 * stores the Agent's result blob.
 */
function createFakeCloud(queued: Array<{ id: string; command: string; payload?: Record<string, unknown> }>) {
  const store = new Map<string, StoredCommand>();
  for (const item of queued) {
    store.set(item.id, { id: item.id, command: item.command, payload: item.payload ?? {}, status: "pending", result: null });
  }

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const jsonResponse = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    // The Agent must always present its bearer credential (docs/agent-api.md).
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse(401, { error: { code: "unauthenticated", message: "Invalid or revoked agent credentials." } });
    }

    if (href.endsWith("/api/agents/commands")) {
      const pending = [...store.values()]
        .filter((c) => c.status === "pending")
        .map((c) => ({ id: c.id, command: c.command, payload: c.payload }));
      return jsonResponse(200, { commands: pending });
    }

    const ackMatch = /\/api\/agents\/commands\/([^/]+)\/ack$/.exec(href);
    if (ackMatch) {
      const stored = store.get(decodeURIComponent(ackMatch[1]!));
      if (!stored) return jsonResponse(404, { error: { code: "not_found", message: "Command not found." } });
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        status?: "completed" | "failed";
        result?: Record<string, unknown>;
      };
      if (body.status !== "completed" && body.status !== "failed") {
        return jsonResponse(400, { error: { code: "invalid_status", message: "status must be 'completed' or 'failed'." } });
      }
      stored.status = body.status;
      stored.result = body.result ?? null;
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(404, { error: { code: "not_found", message: href } });
  });

  return { store, fetchImpl };
}

describe("remote command round trip (issue -> poll -> execute -> ack)", () => {
  let dir: string;
  let deps: CommandHandlerDeps;
  let restartSpooler: ReturnType<typeof vi.fn>;
  let discoverQueues: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "printio-agent-roundtrip-"));
    restartSpooler = vi.fn(async () => {});
    discoverQueues = vi.fn(async () => [
      { windowsQueueName: "Kyocera_Main", driverName: "KX", portName: "IP_10.0.0.5", status: "ready" as const, rawStatus: "Normal" },
    ]);
    deps = {
      localStoragePath: dir,
      spoolerMonitor: {
        listQueueJobs: vi.fn(),
        getPrintJobStatus: vi.fn(),
        cancelPrintJob: vi.fn(async () => {}),
        pollUntilTerminal: vi.fn(),
      },
      printerManager: { discoverQueues, restartSpooler },
      jobQueue: createJobQueue(dir, logger),
      logger,
      refreshHeartbeatNow: vi.fn(async () => {}),
      scheduleServiceRestart: vi.fn(),
      runSelfUpdate: vi.fn(async () => ({
        updated: false,
        reason: "not_a_git_checkout" as const,
        message: "This Agent isn't running from a git clone.",
        repoRoot: dir,
      })),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The loop orchestrator.ts's pollCommands() runs, minus the process-exit bookkeeping. */
  async function drainCommands(client: CloudClient): Promise<RemoteCommandEnvelope[]> {
    const envelopes = await client.getCommands();
    for (const envelope of envelopes) {
      const result = await handleCommand(envelope, deps);
      await client.ackCommand(envelope.id, result.status, result.result);
    }
    return envelopes;
  }

  it("RESTART_PRINT_QUEUE: an issued command is picked up, actually restarts the spooler, and is acked back as completed", async () => {
    const { store, fetchImpl } = createFakeCloud([
      { id: "cmd-1", command: "RESTART_PRINT_QUEUE", payload: { printerProfileId: "profile-1" } },
    ]);
    const client = new CloudClient({
      apiUrl: "https://cloud.example",
      agentId: "agent-1",
      deviceSecret: "secret",
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const picked = await drainCommands(client);

    expect(picked.map((e) => e.command)).toEqual(["RESTART_PRINT_QUEUE"]);
    // The Windows-side effect actually happened...
    expect(restartSpooler).toHaveBeenCalledTimes(1);
    // ...and status was re-checked afterward rather than assumed
    // (docs/architecture.md sec 11).
    expect(discoverQueues).toHaveBeenCalled();
    expect(deps.refreshHeartbeatNow).toHaveBeenCalled();
    // ...and the cloud row is no longer pending, so the admin console can
    // show that it landed.
    expect(store.get("cmd-1")?.status).toBe("completed");
    expect(store.get("cmd-1")?.result).toEqual({ queueCount: 1 });
  });

  it("RESTART_PRINT_QUEUE: a spooler restart that fails is acked back as failed, with the reason, never as silent success", async () => {
    restartSpooler.mockRejectedValueOnce(new Error("Restart-Service Spooler failed: access denied"));
    const { store, fetchImpl } = createFakeCloud([
      { id: "cmd-1", command: "RESTART_PRINT_QUEUE", payload: { printerProfileId: "profile-1" } },
    ]);
    const client = new CloudClient({
      apiUrl: "https://cloud.example",
      agentId: "agent-1",
      deviceSecret: "secret",
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await drainCommands(client);

    expect(store.get("cmd-1")?.status).toBe("failed");
    expect(String(store.get("cmd-1")?.result?.reason)).toContain("access denied");
  });

  it("CHECK_FOR_UPDATE: the Agent's own answer travels all the way back into the command row the console reads", async () => {
    const { store, fetchImpl } = createFakeCloud([{ id: "cmd-2", command: "CHECK_FOR_UPDATE" }]);
    const client = new CloudClient({
      apiUrl: "https://cloud.example",
      agentId: "agent-1",
      deviceSecret: "secret",
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await drainCommands(client);

    expect(store.get("cmd-2")?.status).toBe("completed");
    expect(store.get("cmd-2")?.result).toMatchObject({
      updated: false,
      reason: "not_a_git_checkout",
      message: expect.stringContaining("git clone"),
    });
    expect(deps.scheduleServiceRestart).not.toHaveBeenCalled();
  });

  it("a pending command is only listed until it is acked - a second poll does not re-run it", async () => {
    const { store, fetchImpl } = createFakeCloud([{ id: "cmd-3", command: "REFRESH_PRINTER_STATUS" }]);
    const client = new CloudClient({
      apiUrl: "https://cloud.example",
      agentId: "agent-1",
      deviceSecret: "secret",
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const first = await drainCommands(client);
    const second = await drainCommands(client);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(discoverQueues).toHaveBeenCalledTimes(1);
    expect(store.get("cmd-3")?.status).toBe("completed");
  });

  it("every command in the canonical allow-list round-trips to a terminal, acked state - none is silently dropped", async () => {
    const { store, fetchImpl } = createFakeCloud(
      REMOTE_COMMANDS.map((command, index) => ({ id: `cmd-${index}`, command, payload: {} })),
    );
    const client = new CloudClient({
      apiUrl: "https://cloud.example",
      agentId: "agent-1",
      deviceSecret: "secret",
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await drainCommands(client);

    for (const stored of store.values()) {
      expect(["completed", "failed"]).toContain(stored.status);
    }
  });

  it("an unauthenticated client never gets a command list at all (the bearer credential is not optional)", async () => {
    const { fetchImpl } = createFakeCloud([{ id: "cmd-1", command: "REFRESH_PRINTER_STATUS" }]);
    const client = new CloudClient({
      apiUrl: "https://cloud.example",
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getCommands()).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
