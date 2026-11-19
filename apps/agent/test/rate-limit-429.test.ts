import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudClient } from "../src/cloud-client.js";
import { CloudApiError } from "../src/errors.js";
import { createOrchestrator } from "../src/orchestrator.js";
import { createJobQueue } from "../src/job-queue.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });

function tooMany(retryAfter?: string): Response {
  return new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), {
    status: 429,
    headers: { "content-type": "application/json", ...(retryAfter ? { "retry-after": retryAfter } : {}) },
  });
}

function client(fetchImpl: () => Promise<Response>) {
  return new CloudClient({ apiUrl: "https://cloud.example", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });
}

describe("CloudClient 429 handling", () => {
  it("is not retried inside the request, carries Retry-After, and does not touch the auth-failure counter", async () => {
    const fetchImpl = vi.fn(async () => tooMany("20"));
    const c = client(fetchImpl);
    c.consecutiveAuthFailures = 3;
    const err = await c.getClaimableJobs().catch((e) => e);
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 20 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(c.consecutiveAuthFailures).toBe(3);
    expect(c.rateLimitBackoffMs()).toBeGreaterThan(15_000);
    expect(c.rateLimitBackoffMs()).toBeLessThanOrEqual(20_000);
  });

  it("uses a default pause when Retry-After is missing and caps a silly one", async () => {
    const a = client(async () => tooMany());
    await a.getClaimableJobs().catch(() => undefined);
    expect(a.rateLimitBackoffMs()).toBeGreaterThan(25_000);
    const b = client(async () => tooMany("99999"));
    await b.getClaimableJobs().catch(() => undefined);
    expect(b.rateLimitBackoffMs()).toBeLessThanOrEqual(300_000);
  });

  it("has no back-off after a normal answer", async () => {
    const c = client(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 }));
    await c.getClaimableJobs();
    expect(c.rateLimitBackoffMs()).toBe(0);
  });
});

describe("orchestrator on a 429", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "printio-429-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("treats a 429 poll as a success cycle (no failure outcome, no error log)", async () => {
    const warn = vi.fn();
    const quiet = { ...logger, warn, error: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => quiet } as never;
    const cloud = {
      consecutiveAuthFailures: 0,
      rateLimitBackoffMs: () => 20_000,
      async getClaimableAndCommands() {
        throw new CloudApiError("slow down", "rate_limited", 429, 20);
      },
    };
    const orch = createOrchestrator({
      config: { localStoragePath: dir, pollIntervalSeconds: 3, maxPollIntervalSeconds: 300, heartbeatIntervalSeconds: 30 } as never,
      cloudClient: cloud as unknown as CloudClient,
      jobQueue: createJobQueue(dir, logger),
      printerManager: {} as never,
      spoolerMonitor: {} as never,
      healthMonitor: { isPaused: () => false, adminPollSeconds: () => null, sendHeartbeat: async () => true } as never,
      logger: quiet,
    });
    expect(await orch.runOnce()).toBe("success");
    expect(warn).not.toHaveBeenCalled();
  });
});
