import { describe, expect, it, vi } from "vitest";
import { CloudClient } from "../src/cloud-client.js";
import { CloudApiError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { parsePrepareTimeoutSeconds, parsePrepareWorkerFlag } from "../src/config.js";

const logger = createLogger({ level: "error" });
const json = (status: number, body?: unknown) =>
  body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => impl(String(url), init));
  const c = new CloudClient({ apiUrl: "https://cloud.test", agentId: "agent-1", deviceSecret: "secret", logger, fetchImpl: fetchImpl as unknown as typeof fetch });
  return { c, fetchImpl };
}
const callOf = (f: ReturnType<typeof client>["fetchImpl"], n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];

describe("CloudClient prepare-job calls (docs/PREPARE-JOBS-DESIGN.md)", () => {
  it("claim: 204 is 'nothing waiting', 200 gives the job, always POST with the agent's bearer credential", async () => {
    const none = client(async () => json(204));
    expect(await none.c.claimPrepareJob()).toBeNull();
    const [url, init] = callOf(none.fetchImpl);
    expect(url).toBe("https://cloud.test/api/agents/prepare-jobs/claim");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer agent-1.secret");

    const one = client(async () => json(200, { jobId: "j1", params: { a: 1 }, leaseSeconds: 120 }));
    expect(await one.c.claimPrepareJob()).toEqual({ jobId: "j1", params: { a: 1 }, leaseSeconds: 120 });
  });

  it("claim: a refusal or a broken answer is an error the worker backs off from; 5xx is not retried here", async () => {
    const refused = client(async () => json(403, { error: { code: "forbidden", message: "no" } }));
    await expect(refused.c.claimPrepareJob()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    const broken = client(async () => json(200, {}));
    await expect(broken.c.claimPrepareJob()).rejects.toBeInstanceOf(CloudApiError);
    const down = client(async () => json(503, { error: { code: "down", message: "x" } }));
    await expect(down.c.claimPrepareJob()).rejects.toBeInstanceOf(CloudApiError);
    expect(down.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("original / upload-slot / renew hit the job's own routes and return only what the worker needs", async () => {
    const o = client(async () => json(200, { url: "https://signed/get", expiresInSeconds: 300 }));
    expect(await o.c.getPrepareOriginalUrl("j 1")).toBe("https://signed/get");
    expect(callOf(o.fetchImpl)[0]).toBe("https://cloud.test/api/agents/prepare-jobs/j%201/original");

    const s = client(async () => json(200, { path: "prepared/o/j/x.pdf", token: "t", uploadUrl: "https://signed/put?token=t", apikey: "pub" }));
    expect(await s.c.getPrepareUploadSlot("j1")).toEqual({ path: "prepared/o/j/x.pdf", uploadUrl: "https://signed/put?token=t", apikey: "pub" });
    await expect(client(async () => json(200, { path: "p" })).c.getPrepareUploadSlot("j1")).rejects.toBeInstanceOf(CloudApiError);

    const r = client(async () => json(200, { leaseUntil: "2026-11-19T12:00:00Z" }));
    await r.c.renewPrepareJob("j1");
    expect(callOf(r.fetchImpl)[0]).toBe("https://cloud.test/api/agents/prepare-jobs/j1/renew");
  });

  it("complete sends exactly { result }, fail sends exactly { reason }", async () => {
    const c1 = client(async () => json(200, { ok: true }));
    await c1.c.completePrepareJob("j1", { preparedPath: null, sourcePages: 3 });
    expect(JSON.parse(String(callOf(c1.fetchImpl)[1].body))).toEqual({ result: { preparedPath: null, sourcePages: 3 } });
    const c2 = client(async () => json(200, { ok: true }));
    await c2.c.failPrepareJob("j1", "Too big.");
    expect(JSON.parse(String(callOf(c2.fetchImpl)[1].body))).toEqual({ reason: "Too big." });
  });

  it("a cancelled job arrives as CloudApiError 409 with code 'cancelled' (what the worker keys on)", async () => {
    const c = client(async () => json(409, { error: { code: "cancelled", message: "The sender cancelled this job. Discard your work." } }));
    await expect(c.c.renewPrepareJob("j1")).rejects.toMatchObject({ status: 409, code: "cancelled" });
  });
});

describe("prepare worker settings", () => {
  it("PRINTIO_PREPARE_WORKER: only 1 or true turn it on, anything else is off and never throws", () => {
    for (const on of ["1", "true", " TRUE ", "True"]) expect(parsePrepareWorkerFlag(on)).toBe(true);
    for (const off of [undefined, "", "0", "false", "yes", "on", "banana"]) expect(parsePrepareWorkerFlag(off)).toBe(false);
  });
  it("PRINTIO_PREPARE_TIMEOUT_SECONDS: 10 to 600, default 60, nonsense falls back to 60 (seconds, not minutes)", () => {
    expect(parsePrepareTimeoutSeconds(undefined)).toBe(60);
    expect(parsePrepareTimeoutSeconds("30")).toBe(30);
    expect(parsePrepareTimeoutSeconds(" 600 ")).toBe(600);
    for (const bad of ["", "5", "601", "1e3", "abc", "-1", "12.5", "0"]) expect(parsePrepareTimeoutSeconds(bad)).toBe(60);
  });
});
