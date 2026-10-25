import { describe, expect, it, vi } from "vitest";
import { createWebClient, WebUnavailableError } from "../src/web-client.js";

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(fetchImpl: typeof fetch, extra: { now?: () => number } = {}) {
  return createWebClient({ baseUrl: "https://web.test/", secret: "s".repeat(32), fetchImpl, ...extra });
}

describe("web client printer label", () => {
  it("passes the printer label through when the web app sends one, and tolerates it being absent", async () => {
    const withLabel = vi.fn(async () => json(200, { deviceId: "d", userId: "u", organizationId: "o", displayName: "P", printerLabel: "Printio-MLMI-SZV" }));
    expect(await client(withLabel as unknown as typeof fetch).resolveDevice("h1")).toMatchObject({ kind: "ok", device: { printerLabel: "Printio-MLMI-SZV" } });
    const without = vi.fn(async () => json(200, { deviceId: "d", userId: "u", organizationId: "o", displayName: "P" }));
    const r = await client(without as unknown as typeof fetch).resolveDevice("h2");
    expect(r.kind === "ok" && r.device.printerLabel).toBeUndefined();
  });
});

describe("web client", () => {
  it("sends the Bearer secret and caches a positive resolve for 60 s", async () => {
    let t = 0;
    const f = vi.fn(async () => json(200, { deviceId: "d", userId: "u", organizationId: "o", displayName: "Phone" }));
    const c = client(f as unknown as typeof fetch, { now: () => t });
    expect(await c.resolveDevice("h")).toMatchObject({ kind: "ok", device: { deviceId: "d" } });
    await c.resolveDevice("h");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://web.test/api/gateway/device/resolve");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${"s".repeat(32)}`);
    expect(JSON.parse(init.body as string)).toEqual({ tokenHash: "h" });
    t += 60_001;
    await c.resolveDevice("h");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("maps 404 / 403, remembers them for 30 s only, and stays bounded", async () => {
    let t = 0;
    const answers = [json(404, { error: "unknown_device" }), json(403, { error: "revoked" }), json(403, { error: "inactive_member" })];
    const f = vi.fn(async () => answers.shift() as Response);
    const c = client(f as unknown as typeof fetch, { now: () => t });
    expect(await c.resolveDevice("a")).toEqual({ kind: "unknown" });
    expect(await c.resolveDevice("a")).toEqual({ kind: "unknown" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(await c.resolveDevice("b")).toEqual({ kind: "revoked" });
    expect(await c.resolveDevice("c")).toEqual({ kind: "inactive_member" });
    t += 30_001;
    answers.push(json(404));
    expect(await c.resolveDevice("a")).toEqual({ kind: "unknown" });
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("a flood of distinct invented tokens does not grow the cache without bound", async () => {
    const f = vi.fn(async () => json(404));
    const c = createWebClient({ baseUrl: "https://web.test", secret: "s".repeat(32), fetchImpl: f as unknown as typeof fetch, maxCacheEntries: 50 });
    for (let i = 0; i < 200; i++) await c.resolveDevice(`h${i}`);
    await c.resolveDevice("h199"); // still remembered
    expect(f).toHaveBeenCalledTimes(200);
    await c.resolveDevice("h0"); // evicted
    expect(f).toHaveBeenCalledTimes(201);
  });

  it("5xx, 401, network errors and timeouts all become WebUnavailableError", async () => {
    for (const f of [
      async () => json(503, {}),
      async () => json(401, { error: "unauthorized" }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      await expect(client(f as unknown as typeof fetch).resolveDevice("h")).rejects.toBeInstanceOf(WebUnavailableError);
      await expect(client(f as unknown as typeof fetch).finalize({} as never)).rejects.toBeInstanceOf(WebUnavailableError);
    }
  });

  it("finalize: permanent refusals map to refused; 503/500 stay retryable", async () => {
    const answers = [
      json(403, { error: "quota_exceeded", message: "Monthly quota used up." }),
      json(429, { error: "rate_limited" }),
      json(400, { error: "invalid_request" }),
      json(404, { error: "intake_not_found" }),
      json(403, { error: "revoked" }),
      json(503, { error: "no_printer" }),
      json(500, { error: "internal_error" }),
    ];
    const c = client((async () => answers.shift() as Response) as unknown as typeof fetch);
    expect(await c.finalize({} as never)).toEqual({ kind: "refused", reason: "quota_exceeded", message: "Monthly quota used up." });
    expect(await c.finalize({} as never)).toMatchObject({ kind: "refused", reason: "rate_limited" });
    expect(await c.finalize({} as never)).toMatchObject({ kind: "refused", reason: "invalid_request" });
    expect(await c.finalize({} as never)).toMatchObject({ kind: "refused", reason: "intake_not_found" });
    expect(await c.finalize({} as never)).toMatchObject({ kind: "refused", reason: "revoked" });
    await expect(c.finalize({} as never)).rejects.toThrow(WebUnavailableError);
    await expect(c.finalize({} as never)).rejects.toThrow(WebUnavailableError);
  });

  it("postEvent never throws", async () => {
    const warn = vi.fn();
    const c = createWebClient({ baseUrl: "https://web.test", secret: "x", onWarn: warn, fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    await expect(c.postEvent({ deviceId: "d", type: "info" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("finalize: 200 -> job, 422 -> bad_pdf; getJob 404 -> null; cancel mapping", async () => {
    const answers = [
      json(200, { jobId: "j", jobNumber: "JOB-2026-000007", status: "held", message: "m" }),
      json(422, { error: "bad_pdf", message: "bad" }),
      json(404, {}),
      json(200, { jobId: "j", status: "printing" }),
      json(200, { status: "cancelled" }),
      json(409, { message: "no" }),
      json(404, {}),
    ];
    const calls: string[] = [];
    const f = vi.fn(async (u: string) => {
      calls.push(u);
      return answers.shift() as Response;
    });
    const c = client(f as unknown as typeof fetch);
    expect(await c.finalize({} as never)).toEqual({ kind: "ok", job: { jobId: "j", jobNumber: "JOB-2026-000007", status: "held", message: "m" } });
    expect(await c.finalize({} as never)).toEqual({ kind: "bad_pdf", message: "bad" });
    expect(await c.getJob("j", "d")).toBeNull();
    expect(await c.getJob("j", "d")).toMatchObject({ status: "printing" });
    expect(calls[2]).toBe("https://web.test/api/gateway/jobs/j?deviceId=d");
    expect(await c.cancelJob("j", "d")).toEqual({ kind: "ok", status: "cancelled" });
    expect(await c.cancelJob("j", "d")).toEqual({ kind: "not_cancellable", message: "no" });
    expect(await c.cancelJob("j", "d")).toEqual({ kind: "not_found" });
  });
});

describe("web client: waiting for the printer", () => {
  it("getJob passes the web app's 'waiting' kind through, and ignores anything else", async () => {
    const answers = [
      json(200, { jobId: "j", status: "approved", message: "The printer is not available", waiting: "unavailable" }),
      json(200, { jobId: "j", status: "approved", waiting: "unknown" }),
      json(200, { jobId: "j", status: "approved", waiting: "banana" }),
    ];
    const c = client((async () => answers.shift() as Response) as unknown as typeof fetch);
    expect(await c.getJob("j", "d")).toMatchObject({ status: "approved", waiting: "unavailable" });
    expect(await c.getJob("j", "d")).toMatchObject({ waiting: "unknown" });
    expect((await c.getJob("j", "d"))?.waiting).toBeUndefined();
  });
});
