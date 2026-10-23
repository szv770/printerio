import http from "node:http";
import net from "node:net";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrchestrator } from "../src/orchestrator.js";
import { createJobQueue } from "../src/job-queue.js";
import { createLogger } from "../src/logger.js";
import { CloudApiError, CloudNetworkError } from "../src/errors.js";
import type { ClaimableJob, CloudClient } from "../src/cloud-client.js";

const logger = createLogger({ level: "error" });

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

interface Harness {
  dir: string;
  fileServer: http.Server;
  filePort: number;
  /** What the "document download" answers. */
  fileBody: Buffer;
  fileStatus: number;
  printerServers: net.Server[];
}

let h: Harness;
const sockets = new Set<net.Socket>();

async function startFileServer(): Promise<void> {
  h.fileServer = http.createServer((_req, res) => {
    res.statusCode = h.fileStatus;
    res.setHeader("content-length", h.fileBody.length);
    res.end(h.fileBody);
  });
  await new Promise<void>((r) => h.fileServer.listen(0, "127.0.0.1", r));
  h.filePort = (h.fileServer.address() as net.AddressInfo).port;
}

async function startPrinter(onConn: (s: net.Socket) => void = () => {}): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("data", (d) => received.push(d));
    s.on("error", () => {});
    onConn(s);
  });
  h.printerServers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, received };
}

/** A port nothing listens on: connecting is refused immediately (a printer that is off but whose IP answers). */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

interface CloudOpts {
  /** What getDownloadUrl says the job's status is ("claimed" = current server, "downloading" = old server). */
  jobStatus?: "claimed" | "downloading";
  rawPort: number;
  /** The raw host the cloud names (default 127.0.0.1, the in-process test printer). */
  rawHost?: string;
  profile?: string;
  releaseResult?: unknown | (() => unknown);
  claim?: () => unknown;
  finishing?: { staple: boolean; booklet: boolean; punch: boolean };
  downloadUrlPath?: string;
  /** While set, reportStatus throws it (a network outage / a 409), without recording the report as delivered. */
  failReports?: { current: unknown | null };
}

function fakeCloud(o: CloudOpts) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  /** Status reports the web app actually received, in order. */
  const reported: string[] = [];
  const log = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
  const client = {
    async claimJob(jobId: string) {
      log("claimJob", jobId);
      if (o.claim) return o.claim();
      return { ok: true as const, leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() };
    },
    async getDownloadUrl(jobId: string, opts?: { keepClaimed?: boolean }) {
      log("getDownloadUrl", jobId, opts);
      return {
        downloadUrl: `http://127.0.0.1:${h.filePort}${o.downloadUrlPath ?? "/f.pdf"}`,
        expiresInSeconds: 300,
        fileName: "a.pdf",
        jobStatus: o.jobStatus ?? "claimed",
        printRequest: {
          jobId,
          printerProfileId: o.profile ?? "prof1",
          windowsQueueName: "",
          pageCount: 1,
          copies: 1,
          colorMode: "bw" as const,
          duplex: false,
          paperSize: "letter",
          finishing: o.finishing ?? { staple: false, booklet: false, punch: false },
          raw: { host: o.rawHost ?? "127.0.0.1", port: o.rawPort, staplePosition: "top-left" as const, bindingSide: "left" as const, jobName: "a" },
        },
      };
    },
    async reportStatus(jobId: string, status: string, message?: string) {
      log("reportStatus", jobId, status, message);
      if (o.failReports?.current) throw o.failReports.current;
      reported.push(`${jobId}:${status}`);
    },
    async releaseJob(jobId: string, kind: string, detail?: string) {
      log("releaseJob", jobId, kind, detail);
      const r = typeof o.releaseResult === "function" ? (o.releaseResult as () => unknown)() : o.releaseResult;
      if (r instanceof Error) throw r;
      return r ?? { outcome: "waiting", tries: 1, retryAt: new Date(Date.now() + 30_000).toISOString() };
    },
    async getClaimableJobs() {
      return [];
    },
  };
  return { client: client as unknown as CloudClient, calls, reported };
}

const statuses = (calls: Array<{ fn: string; args: unknown[] }>) => calls.filter((c) => c.fn === "reportStatus").map((c) => c.args[1]);
const fns = (calls: Array<{ fn: string; args: unknown[] }>) => calls.map((c) => c.fn);

function makeOrchestrator(
  cloud: CloudClient,
  extra: Record<string, unknown> = {},
  claimable: ClaimableJob[] = [],
) {
  const jobQueue = createJobQueue(h.dir, logger);
  const cloudWithList = Object.assign(Object.create(cloud as object), { getClaimableJobs: async () => claimable }) as CloudClient;
  const orch = createOrchestrator({
    allowLocalDownloads: true,
    config: { localStoragePath: h.dir, pollIntervalSeconds: 1, maxPollIntervalSeconds: 2 } as never,
    cloudClient: cloudWithList,
    jobQueue,
    printerManager: {} as never,
    spoolerMonitor: {} as never,
    healthMonitor: { isPaused: () => false, sendHeartbeat: async () => true } as never,
    logger,
    // These tests send to an in-process printer on 127.0.0.1, which the real raw-host policy (F8) refuses; the
    // policy has its own describe at the bottom of this file that turns it back on.
    checkRawTarget: async (t: { host: string; port: number }) => ({ ok: true as const, ...t }),
    ...extra,
  } as never);
  return { orch, jobQueue };
}

const job = (n: number, profile = "prof1"): ClaimableJob => ({ jobId: `job-${n}`, printerProfileId: profile, jobNumber: `JOB-${n}` });

beforeEach(async () => {
  h = {
    dir: mkdtempSync(path.join(tmpdir(), "printio-orch-")),
    fileServer: undefined as never,
    filePort: 0,
    fileBody: PDF_BYTES,
    fileStatus: 200,
    printerServers: [],
  };
  await startFileServer();
});
afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await Promise.all([...h.printerServers.map((s) => new Promise((r) => s.close(r))), new Promise((r) => h.fileServer.close(r))]);
  rmSync(h.dir, { recursive: true, force: true });
});

describe("raw job, current server (job stays claimed while it is sent)", () => {
  it("success: asks to keep the job claimed, sends the bytes, then reports the legal chain claimed -> ... -> completed", async () => {
    const printer = await startPrinter((s) => s.on("end", () => s.end()));
    const { client, calls } = fakeCloud({ rawPort: printer.port });
    const { orch, jobQueue } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(calls.find((c) => c.fn === "getDownloadUrl")?.args[1]).toEqual({ keepClaimed: true });
    expect(statuses(calls)).toEqual(["downloading", "downloaded", "printing", "submitted_to_spooler", "completed"]);
    expect(fns(calls)).not.toContain("releaseJob");
    expect(Buffer.concat(printer.received).includes(PDF_BYTES)).toBe(true);
    expect(jobQueue.getJob("job-1")).toBeUndefined();
    expect(readdirSync(path.join(h.dir, "downloads"))).toEqual([]);
  });

  it("the printer refuses the connection (off): the job is RELEASED as 'unavailable', never reported failed, nothing left behind", async () => {
    const { client, calls } = fakeCloud({ rawPort: await closedPort() });
    const { orch, jobQueue } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(calls.filter((c) => c.fn === "releaseJob").map((c) => c.args.slice(0, 2))).toEqual([["job-1", "unavailable"]]);
    expect(statuses(calls)).toEqual([]);
    expect(jobQueue.getJob("job-1")).toBeUndefined();
    expect(existsSync(path.join(h.dir, "downloads")) ? readdirSync(path.join(h.dir, "downloads")) : []).toEqual([]);
  });

  it("the printer stops reading and not everything left this machine (write stall): released as 'unavailable', not failed", async () => {
    const { client, calls } = fakeCloud({ rawPort: 1 });
    const { orch } = makeOrchestrator(client, {
      rawPrint: async () => ({ ok: false as const, reason: "raw print write timed out", failure: { kind: "write_timeout" as const, bytesWritten: 65536, flushed: false } }),
    });
    await orch.processJob(job(1));
    expect(calls.filter((c) => c.fn === "releaseJob").map((c) => c.args[1])).toEqual(["unavailable"]);
    expect(statuses(calls)).toEqual([]);
  });

  const failures: Array<[string, { kind: string; code?: string }, "unavailable" | "unknown" | "FAIL"]> = [
    ["connect timeout", { kind: "connect_timeout" }, "unavailable"],
    ["host unreachable", { kind: "connect_unreachable", code: "EHOSTUNREACH" }, "unavailable"],
    ["write timeout", { kind: "write_timeout" }, "unavailable"],
    ["unknown socket error", { kind: "connect_error", code: "EWEIRD" }, "unknown"],
    ["connection reset mid-write", { kind: "write_error", code: "ECONNRESET" }, "unknown"],
    ["job cannot be built", { kind: "invalid_job" }, "FAIL"],
  ];
  it.each(failures)("decision table, end to end: %s", async (_n, failure, expected) => {
    const { client, calls } = fakeCloud({ rawPort: 1 });
    const { orch } = makeOrchestrator(client, {
      rawPrint: async () => ({ ok: false as const, reason: `raw: ${failure.kind}`, failure }),
    });
    await orch.processJob(job(1));
    if (expected === "FAIL") {
      expect(fns(calls)).not.toContain("releaseJob");
      expect(calls.filter((c) => c.fn === "reportStatus").map((c) => c.args.slice(1, 3))).toEqual([["failed", "raw print: raw: invalid_job"]]);
    } else {
      expect(calls.filter((c) => c.fn === "releaseJob").map((c) => c.args[1])).toEqual([expected]);
      expect(statuses(calls)).toEqual([]);
    }
  });

  it("every byte was sent but the printer never closed the connection: NOT released (a re-send could print twice), failed with an honest message", async () => {
    const server = net.createServer({ allowHalfOpen: true }, (s) => {
      sockets.add(s);
      s.on("data", () => {});
      s.on("error", () => {});
    });
    h.printerServers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { client, calls } = fakeCloud({ rawPort: (server.address() as net.AddressInfo).port });
    const { orch } = makeOrchestrator(client, { rawTimeouts: { writeTimeoutMs: 300, connectTimeoutMs: 300 } });
    await orch.processJob(job(1));
    expect(fns(calls)).not.toContain("releaseJob");
    const failed = calls.find((c) => c.fn === "reportStatus" && c.args[1] === "failed");
    expect(String(failed?.args[2])).toMatch(/did not confirm/);
  });

  it("an impossible job (booklet + separate staple) fails immediately with its message and opens no connection", async () => {
    let connections = 0;
    const printer = await startPrinter(() => {
      connections += 1;
    });
    const { client, calls } = fakeCloud({ rawPort: printer.port, finishing: { staple: true, booklet: true, punch: false } });
    const { orch } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(fns(calls)).not.toContain("releaseJob");
    const failed = calls.find((c) => c.fn === "reportStatus" && c.args[1] === "failed");
    expect(String(failed?.args[2])).toMatch(/staple/);
    expect(connections).toBe(0);
  });

  it("the stored document is gone (404): permanent, fails right away with the reason", async () => {
    h.fileStatus = 404;
    const printer = await startPrinter();
    const { client, calls } = fakeCloud({ rawPort: printer.port });
    const { orch } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(fns(calls)).not.toContain("releaseJob");
    expect(statuses(calls)).toEqual(["failed"]);
  });

  it("the document is not a PDF (an HTML error page): permanent, fails", async () => {
    h.fileBody = Buffer.from("<html>nope</html>");
    const printer = await startPrinter();
    const { client, calls } = fakeCloud({ rawPort: printer.port });
    const { orch } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(statuses(calls)).toEqual(["failed"]);
  });

  it("the document server is unreachable (network): transient, so the job waits instead of failing", async () => {
    const printer = await startPrinter();
    const { client, calls } = fakeCloud({ rawPort: printer.port });
    await new Promise((r) => h.fileServer.close(r));
    const { orch } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(calls.filter((c) => c.fn === "releaseJob").map((c) => c.args[1])).toEqual(["unknown"]);
    expect(statuses(calls)).toEqual([]);
    await startFileServer();
  });

  it("the document server answers 503: transient, waits", async () => {
    h.fileStatus = 503;
    const printer = await startPrinter();
    const { client, calls } = fakeCloud({ rawPort: printer.port });
    const { orch } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(calls.filter((c) => c.fn === "releaseJob").map((c) => c.args[1])).toEqual(["unknown"]);
  });

  it("the web app already failed the job because its window ran out: the agent reports nothing further", async () => {
    const { client, calls } = fakeCloud({ rawPort: await closedPort(), releaseResult: { outcome: "failed" } });
    const { orch, jobQueue } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(statuses(calls)).toEqual([]);
    expect(jobQueue.getJob("job-1")).toBeUndefined();
  });

  it("older web app without the release endpoint (404): falls back to reporting failed, like before", async () => {
    const { client, calls } = fakeCloud({ rawPort: await closedPort(), releaseResult: new CloudApiError("not found", "not_found", 404) });
    const { orch } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(statuses(calls)).toEqual(["failed"]);
  });

  it("release answered 409 (lease already gone / released twice): do nothing more, no failed report", async () => {
    const { client, calls } = fakeCloud({ rawPort: await closedPort(), releaseResult: new CloudApiError("x", "wrong_state", 409) });
    const { orch } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(statuses(calls)).toEqual([]);
  });

  it("release cannot reach the web app at all: no report, no crash (the lease expires and the sweep re-queues it)", async () => {
    const { client, calls } = fakeCloud({ rawPort: await closedPort(), releaseResult: new CloudNetworkError("down") });
    const { orch } = makeOrchestrator(client);
    await expect(orch.processJob(job(1))).resolves.toBeDefined();
    expect(statuses(calls)).toEqual([]);
  });
});

describe("raw job, older server that already moved the job to 'downloading'", () => {
  it("reports downloaded and printing before sending (as it always did) and, when the printer is off, fails (cannot be released from there)", async () => {
    const { client, calls } = fakeCloud({ rawPort: await closedPort(), jobStatus: "downloading" });
    const { orch } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(statuses(calls)).toEqual(["downloaded", "printing", "failed"]);
    expect(fns(calls)).not.toContain("releaseJob");
  });
  it("success keeps the old chain", async () => {
    const printer = await startPrinter((s) => s.on("end", () => s.end()));
    const { client, calls } = fakeCloud({ rawPort: printer.port, jobStatus: "downloading" });
    const { orch } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(statuses(calls)).toEqual(["downloaded", "printing", "submitted_to_spooler", "completed"]);
  });
});

describe("one printer down, many jobs: per-printer cooldown (circuit breaker)", () => {
  it("after one 'unavailable' release the same printer's other jobs are not even claimed until the cooldown passes", async () => {
    let now = 1_000_000;
    const port = await closedPort();
    const { client, calls } = fakeCloud({ rawPort: port });
    const list = [job(1), job(2), job(3)];
    const { orch } = makeOrchestrator(client, { now: () => now }, list);
    expect(await orch.pollClaimableJobs()).toBe(true);
    expect(calls.filter((c) => c.fn === "claimJob").map((c) => c.args[0])).toEqual(["job-1"]);
    expect(calls.filter((c) => c.fn === "releaseJob")).toHaveLength(1);

    // Inside the cooldown: nothing is claimed at all.
    now += 29_000;
    await orch.pollClaimableJobs();
    expect(calls.filter((c) => c.fn === "claimJob")).toHaveLength(1);

    // After the cooldown: exactly one probe again, still the oldest job offered first.
    now += 2_000;
    await orch.pollClaimableJobs();
    expect(calls.filter((c) => c.fn === "claimJob").map((c) => c.args[0])).toEqual(["job-1", "job-1"]);
  });

  it("a different printer's jobs are unaffected by the first printer being down, and order is kept", async () => {
    const down = await closedPort();
    const up = await startPrinter((s) => s.on("end", () => s.end()));
    let calls: Array<{ fn: string; args: unknown[] }> = [];
    const ports: Record<string, number> = { A: down, B: up.port };
    const cloud = fakeCloud({ rawPort: 0 });
    calls = cloud.calls;
    const base = cloud.client as unknown as { getDownloadUrl: (id: string, o?: unknown) => Promise<{ printRequest: { raw: { port: number } } }> };
    const original = base.getDownloadUrl.bind(base);
    base.getDownloadUrl = async (id, o) => {
      const r = await original(id, o);
      r.printRequest.raw.port = id === "job-2" ? ports.B! : ports.A!;
      return r;
    };
    const list = [job(1, "A"), job(2, "B"), job(3, "A"), job(4, "B")];
    const { orch } = makeOrchestrator(cloud.client, {}, list);
    await orch.pollClaimableJobs();
    // job-1 (A) released; job-3 (A) skipped by the breaker; job-2 (B) printed; job-4 (B) claimed too (B's port from the stub: job-4 -> A port, so it is released and B is not blocked by it)
    const claimed = calls.filter((c) => c.fn === "claimJob").map((c) => c.args[0]);
    expect(claimed[0]).toBe("job-1");
    expect(claimed).toContain("job-2");
    expect(claimed).not.toContain("job-3");
  });

  it("a printer that answers again clears the cooldown immediately", async () => {
    let now = 5_000_000;
    const port = await closedPort();
    const { client, calls } = fakeCloud({ rawPort: port });
    const list = [job(1)];
    const { orch } = makeOrchestrator(client, { now: () => now }, list);
    await orch.pollClaimableJobs();
    expect(calls.filter((c) => c.fn === "claimJob")).toHaveLength(1);
    now += 31_000;
    // Printer is back: bind a server on the same port.
    const s2 = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("error", () => {});
      sock.resume(); // a reading printer (without this the data is never consumed and "end" never fires)
      sock.on("end", () => sock.end());
    });
    h.printerServers.push(s2);
    await new Promise<void>((r) => s2.listen(port, "127.0.0.1", r));
    list.length = 0;
    list.push(job(2), job(3));
    await orch.pollClaimableJobs();
    // Both were attempted in the same poll: the first one's success cleared the cooldown, nothing was skipped.
    expect(calls.filter((c) => c.fn === "claimJob").map((c) => c.args[0])).toEqual(["job-1", "job-2", "job-3"]);
    expect(statuses(calls).filter((x) => x === "completed")).toHaveLength(2);
  });
});

describe("fairness: the agent keeps the server's oldest-first order", () => {
  it("processes the list strictly in the order given, one at a time", async () => {
    const printer = await startPrinter((s) => s.on("end", () => s.end()));
    const { client, calls } = fakeCloud({ rawPort: printer.port });
    const { orch } = makeOrchestrator(client, {}, [job(1), job(2), job(3), job(4)]);
    await orch.pollClaimableJobs();
    expect(calls.filter((c) => c.fn === "claimJob").map((c) => c.args[0])).toEqual(["job-1", "job-2", "job-3", "job-4"]);
    expect(statuses(calls).filter((s) => s === "completed")).toHaveLength(4);
    // sequential: job-2 is only claimed after job-1 completed
    const order = calls.map((c) => `${c.fn}:${c.args[0]}:${c.args[1] ?? ""}`);
    expect(order.indexOf("claimJob:job-2:")).toBeGreaterThan(order.indexOf("reportStatus:job-1:completed"));
  });
});

describe("restart recovery", () => {
  it("a job left 'claimed' by a crashed agent is released as unknown (not failed) on startup", async () => {
    const { client, calls } = fakeCloud({ rawPort: 1 });
    const { orch, jobQueue } = makeOrchestrator(client);
    jobQueue.upsertJob("job-9", { printerProfileId: "prof1", state: "claimed" });
    await orch.recoverInFlightJobs();
    expect(calls.filter((c) => c.fn === "releaseJob").map((c) => c.args.slice(0, 2))).toEqual([["job-9", "unknown"]]);
    expect(statuses(calls)).toEqual([]);
    expect(jobQueue.getJob("job-9")).toBeUndefined();
  });
  it("a job already past 'claimed' (downloading) cannot be released, so it is reported failed as before", async () => {
    const { client, calls } = fakeCloud({ rawPort: 1 });
    const { orch, jobQueue } = makeOrchestrator(client);
    jobQueue.upsertJob("job-9", { printerProfileId: "prof1", state: "downloading" });
    await orch.recoverInFlightJobs();
    expect(fns(calls)).not.toContain("releaseJob");
    expect(statuses(calls)).toEqual(["failed"]);
  });
});

describe("a clean send whose status reports could not be delivered (must never turn into a second print)", () => {
  const CHAIN = ["downloading", "downloaded", "printing", "submitted_to_spooler", "completed"];

  it("the web app is unreachable right after the send: nothing is released or re-sent, the chain is kept and re-driven on the next poll", async () => {
    const printer = await startPrinter((s) => s.on("end", () => s.end()));
    const failReports = { current: new CloudNetworkError("down") as unknown };
    const { client, calls, reported } = fakeCloud({ rawPort: printer.port, failReports });
    const { orch, jobQueue } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(fns(calls)).not.toContain("releaseJob");
    expect(reported).toEqual([]);
    expect(jobQueue.getJob("job-1")?.sentUnreported).toEqual(CHAIN);

    failReports.current = null;
    await orch.pollClaimableJobs(); // empty list: the re-drive happens before anything is claimed
    expect(reported).toEqual(CHAIN.map((x) => `job-1:${x}`));
    expect(jobQueue.getJob("job-1")).toBeUndefined();
    expect(Buffer.concat(printer.received).toString("latin1").split("%PDF-1.4").length - 1).toBe(1); // sent exactly once
    expect(fns(calls).filter((f) => f === "claimJob")).toHaveLength(1);
  });

  it("part of the chain delivered, then the outage: only the rest is re-driven, in order", async () => {
    const printer = await startPrinter((s) => s.on("end", () => s.end()));
    const failReports = { current: null as unknown };
    const { client, reported } = fakeCloud({ rawPort: printer.port, failReports });
    let tripped = false;
    const origReport = (client as unknown as { reportStatus: (...a: unknown[]) => Promise<void> }).reportStatus.bind(client);
    (client as unknown as { reportStatus: (...a: unknown[]) => Promise<void> }).reportStatus = async (...a: unknown[]) => {
      if (a[1] === "printing" && !tripped) {
        tripped = true;
        failReports.current = new CloudNetworkError("down");
      }
      return origReport(...a);
    };
    const { orch, jobQueue } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(reported).toEqual(["job-1:downloading", "job-1:downloaded"]);
    expect(jobQueue.getJob("job-1")?.sentUnreported).toEqual(["printing", "submitted_to_spooler", "completed"]);
    failReports.current = null;
    await orch.pollClaimableJobs();
    expect(reported).toEqual(CHAIN.map((x) => `job-1:${x}`));
  });

  it("the web app answers 409 (the job is no longer ours, e.g. the sweep re-queued it): the record is dropped, nothing is retried for ever", async () => {
    const printer = await startPrinter((s) => s.on("end", () => s.end()));
    const failReports = { current: new CloudApiError("illegal", "illegal_transition", 409) as unknown };
    const { client, calls } = fakeCloud({ rawPort: printer.port, failReports });
    const { orch, jobQueue } = makeOrchestrator(client);
    await orch.processJob(job(1));
    expect(jobQueue.getJob("job-1")).toBeUndefined();
    const before = calls.filter((c) => c.fn === "reportStatus").length;
    await orch.pollClaimableJobs();
    expect(calls.filter((c) => c.fn === "reportStatus").length).toBe(before);
  });

  it("the agent restarts between the send and the reports: startup re-drives the chain instead of releasing the job to be printed again", async () => {
    const printer = await startPrinter((s) => s.on("end", () => s.end()));
    const failReports = { current: new CloudNetworkError("down") as unknown };
    const first = fakeCloud({ rawPort: printer.port, failReports });
    await makeOrchestrator(first.client).orch.processJob(job(1));

    const second = fakeCloud({ rawPort: printer.port });
    const { orch } = makeOrchestrator(second.client); // new process: reloads the job queue from disk
    await orch.recoverInFlightJobs();
    expect(fns(second.calls)).not.toContain("releaseJob");
    expect(second.reported).toEqual(CHAIN.map((x) => `job-1:${x}`));
  });
});

describe("raw host policy (security review F8): the agent only sends to private-LAN printers", () => {
  const policyOn = { checkRawTarget: undefined };

  it.each(["127.0.0.1", "169.254.169.254", "8.8.8.8", "224.0.0.1"])("%s: the job is failed in plain words and nothing is sent or connected to", async (rawHost) => {
    const rawPrint = vi.fn();
    const { client, calls } = fakeCloud({ rawPort: 9100, rawHost });
    const { orch, jobQueue } = makeOrchestrator(client, { ...policyOn, rawPrint });
    await orch.processJob(job(1));
    expect(rawPrint).not.toHaveBeenCalled();
    expect(fns(calls)).not.toContain("releaseJob"); // permanent: it will never be allowed, so it must not wait forever
    const failed = calls.find((c) => c.fn === "reportStatus" && c.args[1] === "failed");
    expect(failed?.args[2]).toMatch(/private network address/i);
    expect(jobQueue.getJob("job-1")?.state).toBe("failed");
  });

  it("a port outside 1-65535 is refused", async () => {
    const rawPrint = vi.fn();
    const { client, calls } = fakeCloud({ rawPort: 70000, rawHost: "192.168.100.168" });
    const { orch } = makeOrchestrator(client, { ...policyOn, rawPrint });
    await orch.processJob(job(1));
    expect(rawPrint).not.toHaveBeenCalled();
    expect(calls.find((c) => c.fn === "reportStatus" && c.args[1] === "failed")?.args[2]).toMatch(/port/i);
  });

  it("the owner's printer 192.168.100.168:9100 is allowed and reaches the sender with the checked address", async () => {
    const rawPrint = vi.fn(async () => ({ ok: true as const, bytesSent: 10 }));
    const { client } = fakeCloud({ rawPort: 9100, rawHost: "192.168.100.168" });
    const { orch } = makeOrchestrator(client, { ...policyOn, rawPrint });
    await orch.processJob(job(1));
    expect(rawPrint).toHaveBeenCalledTimes(1);
    expect((rawPrint.mock.calls[0] as unknown as [{ raw: { host: string; port: number } }])[0].raw).toMatchObject({ host: "192.168.100.168", port: 9100 });
  });

  it("PRINTIO_RAW_ALLOWED_HOSTS narrows it further: another private address is refused", async () => {
    const rawPrint = vi.fn();
    const { client, calls } = fakeCloud({ rawPort: 9100, rawHost: "10.0.0.5" });
    const cfg = { localStoragePath: h.dir, pollIntervalSeconds: 1, maxPollIntervalSeconds: 2, rawAllowedHosts: ["192.168.100.168"] };
    const { orch } = makeOrchestrator(client, { ...policyOn, rawPrint, config: cfg });
    await orch.processJob(job(1));
    expect(rawPrint).not.toHaveBeenCalled();
    expect(calls.find((c) => c.fn === "reportStatus" && c.args[1] === "failed")?.args[2]).toMatch(/PRINTIO_RAW_ALLOWED_HOSTS/);
  });
});
