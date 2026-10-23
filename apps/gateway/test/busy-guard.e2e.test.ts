// Busy guard end to end (real http server, fake web, fake storage): the cap on in-flight upload bytes, the per-device
// limit, release on every exit path, and a 12-simultaneous-upload / 4-device storm.
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { attr, encodeIpp, OP, STATUS, TAG, decodeIpp } from "../src/ipp/codec.js";
import { createLogger } from "../src/logger.js";
import { flatGroup, jobGroup, operationGroup, pdfOf, startHarness, type Harness, type HttpResult } from "./helpers.js";

const KB = 1024;
const SERVER_BUSY = 0x0507;
const BUSY_MESSAGE = "The server is busy right now. Please try again in a moment.";

let h: Harness;
let lines: string[] = [];
afterEach(async () => {
  await h.close();
});

async function start(over: Parameters<typeof startHarness>[0] = {}) {
  lines = [];
  h = await startHarness({ logger: createLogger("info", (l) => lines.push(l)), ...over });
}

const printerUri = () => attr(TAG.uri, "printer-uri", `https://${h.host}/ipp/print`);
const printJob = (name = "doc.pdf") => ({
  code: OP.printJob,
  groups: [
    operationGroup(printerUri(), attr(TAG.name, "requesting-user-name", "pixel"), attr(TAG.name, "job-name", name), attr(TAG.mime, "document-format", "application/pdf")),
    jobGroup(attr(TAG.integer, "copies", 1)),
  ],
});
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = (r: { ipp: { code: number } }) => r.ipp.code;
const host = (d: { host: string }) => ({ host: d.host });

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not reached");
    await sleep(10);
  }
}

describe("busy reply", () => {
  it("an upload that does not fit under the cap gets IPP server-error-busy with a plain message, Retry-After and a closed connection; it is logged", async () => {
    await start({ maxBodyBytes: 600 * KB, guard: { maxInflightBytes: 600 * KB, maxPerKey: 2 } });
    const g = gate();
    h.web.finalizeGate = g.p;
    const first = h.ipp(printJob("a.pdf"), pdfOf("A", 400 * KB));
    await waitFor(() => h.guard.inflightBytes >= 400 * KB);
    const second = await h.ipp(printJob("b.pdf"), pdfOf("B", 400 * KB), host(h.addDevice("dev-2")));
    expect(code(second)).toBe(SERVER_BUSY);
    expect(flatGroup(second.ipp, TAG.operation)["status-message"]).toBe(BUSY_MESSAGE);
    expect(second.http.status).toBe(200);
    expect(second.http.headers["retry-after"]).toMatch(/^\d+$/);
    expect(second.http.headers.connection).toBe("close");
    expect(lines.some((l) => /busy/i.test(l) && JSON.parse(l).level === "warn")).toBe(true);
    expect(lines.join("\n")).not.toMatch(/u-[a-z2-7]{39}/i);
    g.open();
    expect(code(await first)).toBe(STATUS.ok);
    // Not a permanent refusal: once the first is done the same upload is accepted.
    h.web.finalizeGate = null;
    expect(code(await h.ipp(printJob("b.pdf"), pdfOf("B", 400 * KB), host({ host: h.host })))).toBe(STATUS.ok);
    expect(h.guard.inflightBytes).toBe(0);
    expect(h.guard.activeUploads).toBe(0);
  });

  it("the per-file limit still wins: a file over the limit is 'too large', not 'busy'", async () => {
    await start({ maxBodyBytes: 200 * KB, guard: { maxInflightBytes: 1, maxPerKey: 1 } });
    const r = await h.ipp(printJob(), pdfOf("big", 300 * KB));
    expect(code(r)).toBe(STATUS.requestEntityTooLarge);
    expect(h.guard.inflightBytes).toBe(0);
  });

  it("at most 2 uploads per device in flight; a third is busy, other devices are not affected", async () => {
    await start({ guard: { maxInflightBytes: 100 * 1024 * KB, maxPerKey: 2 } });
    const g = gate();
    h.web.finalizeGate = g.p;
    const mk = (tag: string, dev?: { host: string }) => h.ipp(printJob(tag), pdfOf(tag, 100 * KB), dev ? host(dev) : undefined);
    const a = mk("a");
    const b = mk("b");
    await waitFor(() => h.guard.activeFor(h.token) === 2);
    const c = await mk("c");
    expect(code(c)).toBe(SERVER_BUSY);
    const other = h.addDevice("dev-2");
    const d = mk("d", other);
    await sleep(50);
    g.open();
    expect(code(await a)).toBe(STATUS.ok);
    expect(code(await b)).toBe(STATUS.ok);
    expect(code(await d)).toBe(STATUS.ok);
    expect(h.guard.activeUploads).toBe(0);
  });

  it("small requests (status polls, printer attributes, Validate-Job) are never turned away, even when the cap is full", async () => {
    await start({ maxBodyBytes: 600 * KB, guard: { maxInflightBytes: 600 * KB, maxPerKey: 1 } });
    const g = gate();
    h.web.finalizeGate = g.p;
    const upload = h.ipp(printJob("a.pdf"), pdfOf("A", 500 * KB));
    await waitFor(() => h.guard.inflightBytes >= 500 * KB);
    const attrs = await h.ipp({ code: OP.getPrinterAttributes, groups: [operationGroup(printerUri())] });
    const validate = await h.ipp({ code: OP.validateJob, groups: [operationGroup(printerUri(), attr(TAG.mime, "document-format", "application/pdf"))] });
    const jobs = await h.ipp({ code: OP.getJobs, groups: [operationGroup(printerUri())] });
    expect([code(attrs), code(validate), code(jobs)]).toEqual([STATUS.ok, STATUS.ok, STATUS.ok]);
    g.open();
    await upload;
  });
});

describe("the counters always come back to zero", () => {
  it("when the client disconnects in the middle of an upload", async () => {
    await start({ maxBodyBytes: 1024 * KB });
    const body = Buffer.concat([encodeIpp({ ...printJob(), requestId: 1 }), pdfOf("abort", 400 * KB)]);
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: h.port,
        method: "POST",
        path: "/ipp/print",
        headers: { host: h.host, "content-type": "application/ipp", "content-length": String(body.length) },
      });
      req.on("error", () => {});
      req.write(body.subarray(0, 100 * KB));
      setTimeout(() => {
        expect(h.guard.inflightBytes).toBeGreaterThan(0); // the declared size is reserved while it uploads
        req.destroy();
        resolve();
      }, 100);
    });
    await waitFor(() => h.guard.inflightBytes === 0 && h.guard.activeUploads === 0);
    expect(h.web.finalizeCalls).toHaveLength(0);
  });

  it("when a chunked upload (no Content-Length) is aborted", async () => {
    await start({ maxBodyBytes: 1024 * KB });
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: h.port,
        method: "POST",
        path: "/ipp/print",
        headers: { host: h.host, "content-type": "application/ipp", "transfer-encoding": "chunked" },
      });
      req.on("error", () => {});
      req.write(Buffer.concat([encodeIpp({ ...printJob(), requestId: 1 }), pdfOf("abort2", 200 * KB)]));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    await waitFor(() => h.guard.inflightBytes === 0 && h.guard.activeUploads === 0);
  });

  it("when the web app is down (the request still finishes, and releases)", async () => {
    await start();
    h.web.finalizeDown = true;
    const r = await h.ipp(printJob(), pdfOf("down", 100 * KB));
    expect(code(r)).toBe(STATUS.temporaryError);
    expect(h.guard.inflightBytes).toBe(0);
    expect(h.guard.activeUploads).toBe(0);
  });

  it("when a chunked body grows past the cap mid-stream: busy, nothing kept", async () => {
    await start({ maxBodyBytes: 600 * KB, guard: { maxInflightBytes: 600 * KB, maxPerKey: 2 } });
    const g = gate();
    h.web.finalizeGate = g.p;
    const holder = h.ipp(printJob("hold.pdf"), pdfOf("hold", 400 * KB));
    await waitFor(() => h.guard.inflightBytes >= 400 * KB);
    const other = h.addDevice("dev-2");
    const big = Buffer.concat([encodeIpp({ ...printJob(), requestId: 9 }), pdfOf("chunky", 400 * KB)]);
    const res: HttpResult = await h.post(big, { chunked: true, host: other.host });
    expect(decodeIpp(res.body).code).toBe(SERVER_BUSY);
    g.open();
    await holder;
    expect(h.guard.inflightBytes).toBe(0);
    expect(h.guard.activeUploads).toBe(0);
  });
});

describe("storm: 12 simultaneous uploads from 4 devices", () => {
  it("never crashes, honours both limits, returns to zero, and identical retries never create a second web job", async () => {
    // Per device: the same document twice (a phone retry) and a different one. 4 x 3 = 12 requests at once.
    await start({ maxBodyBytes: 1024 * KB, guard: { maxInflightBytes: 1024 * KB, maxPerKey: 2 } });
    const devices = [{ host: h.host, id: "dev-1" }, ...["dev-2", "dev-3", "dev-4"].map((id) => ({ host: h.addDevice(id).host, id }))];
    const g = gate();
    h.web.finalizeGate = g.p;

    const sends: Array<{ dev: string; doc: string; promise: Promise<{ http: HttpResult; ipp: ReturnType<typeof decodeIpp> }> }> = [];
    for (const d of devices) {
      for (const doc of ["same", "same", "other"]) {
        sends.push({ dev: d.id, doc, promise: h.ipp(printJob(`${doc}.pdf`), pdfOf(`${d.id}-${doc}`, 250 * KB), { host: d.host }) });
      }
    }
    // Let them all arrive while finalize is held shut, so they genuinely overlap.
    await sleep(400);
    expect(h.guard.peakPerKey).toBeLessThanOrEqual(2);
    expect(h.guard.peakInflightBytes).toBeLessThanOrEqual(1024 * KB);
    g.open();
    h.web.finalizeGate = null;

    const results = await Promise.all(sends.map(async (s) => ({ ...s, reply: await s.promise })));
    const codes = results.map((r) => r.reply.ipp.code);
    expect(codes.every((c) => c === STATUS.ok || c === SERVER_BUSY)).toBe(true);
    expect(codes.filter((c) => c === SERVER_BUSY).length).toBeGreaterThan(0);
    for (const r of results.filter((x) => x.reply.ipp.code === SERVER_BUSY)) {
      expect(r.reply.http.headers["retry-after"]).toBeDefined();
    }
    expect(h.guard.peakInflightBytes).toBeLessThanOrEqual(1024 * KB);
    expect(h.guard.peakPerKey).toBeLessThanOrEqual(2);
    expect(h.guard.inflightBytes).toBe(0);
    expect(h.guard.activeUploads).toBe(0);

    // Phones retry what was turned away (and, being phones, some retry what already worked).
    for (const r of results) {
      const again = await h.ipp(printJob(`${r.doc}.pdf`), pdfOf(`${r.dev}-${r.doc}`, 250 * KB), { host: devices.find((d) => d.id === r.dev)!.host });
      expect(again.ipp.code).toBe(STATUS.ok);
    }

    // Exactly one web job per distinct (device, document): 4 devices x 2 documents.
    expect(h.web.finalizeCalls).toHaveLength(8);
    expect(h.web.jobs.size).toBe(8);
    const perDevice = new Map<string, number>();
    for (const c of h.web.finalizeCalls) perDevice.set(c.deviceId, (perDevice.get(c.deviceId) ?? 0) + 1);
    expect([...perDevice.values()]).toEqual([2, 2, 2, 2]);
    expect(h.guard.inflightBytes).toBe(0);
    expect(h.guard.activeUploads).toBe(0);

    // The server is still healthy.
    const health = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: h.port, path: "/healthz" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    expect(health).toBe(200);
  }, 30_000);
});
