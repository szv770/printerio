import { describe, expect, it, vi } from "vitest";
import { CloudClient } from "../src/cloud-client.js";
import { CloudApiError, CloudNetworkError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Gives the mock the same call signature as `fetch` so `.mock.calls[n]` is typed as [url, init] rather than []. */
function mockFetch(impl: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>) {
  return vi.fn(impl);
}

describe("CloudClient auth header shaping", () => {
  it("sends no Authorization header for register()", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { agentId: "a1", deviceSecret: "s1", organizationId: "org1" }));
    const client = new CloudClient({ apiUrl: "https://cloud.example", logger, fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.register("ENROLL123");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(init?.body))).toEqual({ enrollmentCode: "ENROLL123" });
  });

  it("sends `Bearer <agentId>.<deviceSecret>` for authenticated calls", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { ok: true, serverTime: "2026-01-01T00:00:00Z" }));
    const client = new CloudClient({
      apiUrl: "https://cloud.example",
      agentId: "agent-42",
      deviceSecret: "topsecret",
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.heartbeat("1.0.0", []);

    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer agent-42.topsecret");
  });

  it("throws NOT_REGISTERED (never calls fetch) when credentials are missing for an authenticated call", async () => {
    const fetchImpl = vi.fn();
    const client = new CloudClient({ apiUrl: "https://cloud.example", logger, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.heartbeat("1.0.0", [])).rejects.toThrow(CloudApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("CloudClient endpoint shaping", () => {
  it("getClaimableJobs unwraps { jobs: [...] }", async () => {
    const jobs = [{ jobId: "j1", printerProfileId: "pp1", jobNumber: "JOB-2026-000001" }];
    const fetchImpl = mockFetch(async () => jsonResponse(200, { jobs }));
    const client = new CloudClient({ apiUrl: "https://c", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.getClaimableJobs();
    expect(result).toEqual(jobs);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/api/agents/jobs/claimable");
  });

  it("claimJob returns { ok:false, reason } on 409 without throwing (this is an expected outcome, not an error)", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(409, { ok: false, reason: "already_claimed" }));
    const client = new CloudClient({ apiUrl: "https://c", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.claimJob("job-1");
    expect(result).toEqual({ ok: false, reason: "already_claimed" });
  });

  it("claimJob returns { ok:true, leaseExpiresAt } on 200", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { ok: true, leaseExpiresAt: "2026-01-01T00:05:00Z" }));
    const client = new CloudClient({ apiUrl: "https://c", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.claimJob("job-1");
    expect(result).toEqual({ ok: true, leaseExpiresAt: "2026-01-01T00:05:00Z" });
  });

  it("reportStatus posts the documented body shape", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { ok: true }));
    const client = new CloudClient({ apiUrl: "https://c", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.reportStatus("job-1", "failed", "printer offline", { foo: "bar" });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/api/agents/jobs/job-1/status");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      status: "failed",
      message: "printer offline",
      metadata: { foo: "bar" },
    });
  });

  it("throws CloudApiError with the documented { error: { code, message } } envelope on a 4xx", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(403, { error: { code: "LEASE_MISMATCH", message: "not your lease" } }));
    const client = new CloudClient({ apiUrl: "https://c", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.getDownloadUrl("job-1")).rejects.toMatchObject({
      name: "CloudApiError",
      code: "LEASE_MISMATCH",
      status: 403,
    });
  });
});

describe("CloudClient retry/backoff", () => {
  it(
    "retries on 5xx and eventually succeeds",
    async () => {
      let calls = 0;
      const fetchImpl = mockFetch(async () => {
        calls += 1;
        if (calls < 3) return jsonResponse(503, { error: { code: "UNAVAILABLE", message: "try again" } });
        return jsonResponse(200, { ok: true, serverTime: "now" });
      });
      const client = new CloudClient({ apiUrl: "https://c", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });

      await client.reportStatus("job-1", "printing");
      expect(calls).toBe(3);
    },
    10_000,
  );

  it("does not retry on a 4xx", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(400, { error: { code: "BAD_REQUEST", message: "nope" } }));
    const client = new CloudClient({ apiUrl: "https://c", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.heartbeat("1.0.0", [])).rejects.toThrow(CloudApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry the idempotent polls (heartbeat, commands, claimable) on 5xx or network errors: the next cycle is the retry", async () => {
    for (const call of [
      (c: CloudClient) => c.heartbeat("1.0.0", []),
      (c: CloudClient) => c.getCommands(),
      (c: CloudClient) => c.getClaimableJobs(),
    ]) {
      const f5xx = mockFetch(async () => jsonResponse(503, { error: { code: "UNAVAILABLE", message: "x" } }));
      await expect(call(new CloudClient({ apiUrl: "https://c", agentId: "a", deviceSecret: "s", logger, fetchImpl: f5xx as unknown as typeof fetch }))).rejects.toThrow(CloudApiError);
      expect(f5xx).toHaveBeenCalledTimes(1);
      const fNet = mockFetch(async () => {
        throw new TypeError("fetch failed");
      });
      await expect(call(new CloudClient({ apiUrl: "https://c", agentId: "a", deviceSecret: "s", logger, fetchImpl: fNet as unknown as typeof fetch }))).rejects.toBeInstanceOf(CloudNetworkError);
      expect(fNet).toHaveBeenCalledTimes(1);
    }
  });

  it("counts consecutive 401/403 answers to the polls and resets on any success", async () => {
    let status = 401;
    const fetchImpl = mockFetch(async () => (status === 200 ? jsonResponse(200, { jobs: [] }) : jsonResponse(status, { error: { code: "unauthenticated", message: "x" } })));
    const client = new CloudClient({ apiUrl: "https://c", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.getClaimableJobs().catch(() => undefined);
    status = 403;
    await client.getClaimableJobs().catch(() => undefined);
    expect(client.consecutiveAuthFailures).toBe(2);
    status = 200;
    await client.getClaimableJobs();
    expect(client.consecutiveAuthFailures).toBe(0);
  });

  it(
    "normalizes a raw fetch/network failure into CloudNetworkError, never letting the raw error escape",
    async () => {
      const fetchImpl = mockFetch(async () => {
        throw new TypeError("fetch failed");
      });
      const client = new CloudClient({ apiUrl: "https://c", agentId: "a", deviceSecret: "s", logger, fetchImpl: fetchImpl as unknown as typeof fetch });

      await expect(client.heartbeat("1.0.0", [])).rejects.toBeInstanceOf(CloudNetworkError);
    },
    15_000,
  );
});
