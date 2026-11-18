// F6: pre-auth DoS hardening, against a real server on 127.0.0.1 with raw sockets.
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { attr, decodeIpp, encodeIpp, OP, STATUS, TAG } from "../src/ipp/codec.js";
import { jobGroup, operationGroup, pdfOf, startHarness, type Harness } from "./helpers.js";

const KB = 1024;
let h: Harness;
const socks: net.Socket[] = [];
afterEach(async () => {
  for (const s of socks.splice(0)) s.destroy();
  await h.close();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens a raw TCP connection and collects everything the server sends. */
function raw(port: number, write: (s: net.Socket) => void) {
  const s = net.connect(port, "127.0.0.1");
  socks.push(s);
  const out: Buffer[] = [];
  let closed = false;
  s.on("data", (c) => out.push(c));
  s.on("error", () => {});
  s.on("close", () => (closed = true));
  s.on("connect", () => write(s));
  return {
    sock: s,
    text: () => Buffer.concat(out).toString("latin1"),
    body: () => {
      const b = Buffer.concat(out);
      const i = b.indexOf("\r\n\r\n");
      return i < 0 ? Buffer.alloc(0) : b.subarray(i + 4);
    },
    get closed() {
      return closed;
    },
  };
}
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not reached");
    await sleep(10);
  }
}
const ippHead = (hostHdr: string, len: number, extra = "") =>
  `POST /ipp/print HTTP/1.1\r\nHost: ${hostHdr}\r\nContent-Type: application/ipp\r\nContent-Length: ${len}\r\n${extra}\r\n`;
const getAttrs = () =>
  encodeIpp({ code: OP.getPrinterAttributes, requestId: 1, groups: [operationGroup(attr(TAG.uri, "printer-uri", "https://x.test/x"))] });
const printJobMsg = () =>
  encodeIpp({
    code: OP.printJob,
    requestId: 7,
    groups: [operationGroup(attr(TAG.uri, "printer-uri", "https://x.test/x"), attr(TAG.mime, "document-format", "application/pdf")), jobGroup()],
  });
const code = (b: Buffer) => decodeIpp(b).code;
/** A well-formed device hostname whose token is not registered. */
const bogusHost = (n: number) => `u-${"a".repeat(36)}${String(n).padStart(3, "a").replace(/[^a-z2-7]/g, "b")}.example.test`;

describe("identity is resolved before the document is buffered", () => {
  it("an unknown token announcing a big body is refused right away without sending the body, and takes no upload budget", async () => {
    h = await startHarness({ maxBodyBytes: 10 * KB * KB, guard: { maxInflightBytes: 20 * KB * KB, maxPerKey: 2 } });
    const c = raw(h.port, (s) => s.write(ippHead(bogusHost(1), 5 * KB * KB) + "IPPJUNK"));
    await until(() => c.body().length > 0);
    expect(code(c.body())).toBe(STATUS.notAuthorized);
    expect(h.guard.peakInflightBytes).toBe(0);
    await until(() => c.closed);
  });

  it("a flood of unknown-token uploads cannot starve a real device of the upload budget", async () => {
    h = await startHarness({ maxBodyBytes: 600 * KB, guard: { maxInflightBytes: 600 * KB, maxPerKey: 2 } });
    for (let i = 0; i < 6; i++) raw(h.port, (s) => s.write(ippHead(bogusHost(i), 500 * KB) + "x"));
    await sleep(150);
    expect(h.guard.inflightBytes).toBe(0);
    const ok = await h.ipp({ code: OP.printJob, groups: [operationGroup(attr(TAG.mime, "document-format", "application/pdf")), jobGroup()] }, pdfOf("A", 400 * KB));
    expect(ok.ipp.code).toBe(STATUS.ok);
  });

  it("when the web API is down, a large upload gets 0x0506 immediately instead of being buffered", async () => {
    h = await startHarness({ maxBodyBytes: 10 * KB * KB });
    h.web.down = true;
    const c = raw(h.port, (s) => s.write(ippHead(h.host, 5 * KB * KB) + "IPP"));
    await until(() => c.body().length > 0);
    expect(code(c.body())).toBe(STATUS.temporaryError);
    expect(h.guard.peakInflightBytes).toBe(0);
  });

  it("small requests from unknown tokens keep their old behaviour (404 for Get-Printer-Attributes, not-authorized for jobs)", async () => {
    h = await startHarness();
    expect((await h.post(getAttrs(), { host: bogusHost(1) })).status).toBe(404);
    const j = await h.post(printJobMsg(), { host: bogusHost(2) });
    expect(code(j.body)).toBe(STATUS.notAuthorized);
  });
});

describe("rate limits", () => {
  it("per-IP: over the limit gets an IPP busy with Retry-After, resolve is not called, other IPs are unaffected (CF header from loopback)", async () => {
    h = await startHarness({ limits: { perIpRequestsPerMin: 5 } });
    const asIp = (ip: string) => ({ headers: { "cf-connecting-ip": ip } });
    for (let i = 0; i < 5; i++) expect((await h.post(getAttrs(), asIp("203.0.113.1"))).status).toBe(200);
    const before = h.web.resolveCalls;
    const r = await h.post(getAttrs(), asIp("203.0.113.1"));
    expect(code(r.body)).toBe(STATUS.serverBusy);
    expect(r.headers["retry-after"]).toMatch(/^\d+$/);
    expect(h.web.resolveCalls).toBe(before);
    expect((await h.post(getAttrs(), asIp("203.0.113.2"))).status).toBe(200);
  });

  it("a spoofed CF-Connecting-IP is ignored when the peer is not a trusted proxy", async () => {
    h = await startHarness({ limits: { perIpRequestsPerMin: 3 }, trustedProxies: [] });
    for (let i = 0; i < 3; i++) await h.post(getAttrs(), { headers: { "cf-connecting-ip": `203.0.113.${i + 1}` } });
    const r = await h.post(getAttrs(), { headers: { "cf-connecting-ip": "203.0.113.99" } });
    expect(code(r.body)).toBe(STATUS.serverBusy);
  });

  it("the global limit applies across IPs", async () => {
    h = await startHarness({ limits: { globalRequestsPerMin: 4, perIpRequestsPerMin: 100 } });
    for (let i = 0; i < 4; i++) await h.post(getAttrs(), { headers: { "cf-connecting-ip": `203.0.113.${i + 1}` } });
    const r = await h.post(getAttrs(), { headers: { "cf-connecting-ip": "203.0.113.50" } });
    expect(code(r.body)).toBe(STATUS.serverBusy);
  });

  it("one flooding address cannot use up the shared allowance: other addresses can still print", async () => {
    h = await startHarness({ limits: { globalRequestsPerMin: 6, perIpRequestsPerMin: 3 } });
    // The flooder's first 3 requests count against the shared allowance; the other 17 are refused by its own limit and must NOT be charged.
    for (let i = 0; i < 20; i++) await h.post(getAttrs(), { headers: { "cf-connecting-ip": "203.0.113.1" } }).catch(() => undefined);
    const other = await h.post(getAttrs(), { headers: { "cf-connecting-ip": "203.0.113.2" } });
    expect(code(other.body)).not.toBe(STATUS.serverBusy);
  });

  it("a per-IP limit on unknown-token lookups stops the resolve amplification", async () => {
    h = await startHarness({ limits: { unknownTokensPerIpPerMin: 3, perIpRequestsPerMin: 1000 } });
    for (let i = 0; i < 3; i++) await h.post(getAttrs(), { host: bogusHost(i) });
    const before = h.web.resolveCalls;
    const r = await h.post(getAttrs(), { host: bogusHost(50) });
    expect(code(r.body)).toBe(STATUS.serverBusy);
    expect(h.web.resolveCalls).toBe(before);
  });

  it("healthz is never rate limited", async () => {
    h = await startHarness({ limits: { perIpRequestsPerMin: 1, globalRequestsPerMin: 1 } });
    for (let i = 0; i < 5; i++) expect((await h.post(Buffer.alloc(0), { method: "GET", path: "/healthz", host: "127.0.0.1" })).status).toBe(200);
  });
});

describe("connection and timing limits", () => {
  it("slow-loris: a connection that never finishes its headers is cut and the server keeps serving", async () => {
    h = await startHarness({ limits: { headersTimeoutMs: 300 } });
    const c = raw(h.port, (s) => s.write("POST /ipp/print HTTP/1.1\r\nHost: x\r\nX-A: "));
    await until(() => c.closed, 4000);
    expect((await h.post(getAttrs())).status).toBe(200);
  });

  it("a body that stalls is cut, and the upload lease is released", async () => {
    h = await startHarness({ maxBodyBytes: 600 * KB, guard: { maxInflightBytes: 600 * KB, maxPerKey: 2 }, limits: { bodyStallMs: 300 } });
    const c = raw(h.port, (s) => s.write(ippHead(h.host, 200 * KB) + "IPP"));
    await until(() => h.guard.activeUploads === 1);
    await until(() => c.closed, 3000);
    await until(() => h.guard.activeUploads === 0);
    expect(h.guard.inflightBytes).toBe(0);
  });

  it("an oversized header block is rejected and the server survives", async () => {
    h = await startHarness({ limits: { maxHeaderBytes: 2048 } });
    const c = raw(h.port, (s) => s.write(ippHead(h.host, 0, `X-Big: ${"a".repeat(8000)}\r\n`)));
    await until(() => c.closed);
    expect(c.text()).toMatch(/^HTTP\/1\.1 (431|400)/);
    expect((await h.post(getAttrs())).status).toBe(200);
  });

  it("caps total connections", async () => {
    h = await startHarness({ limits: { maxConnections: 5 } });
    const idle = Array.from({ length: 12 }, () => raw(h.port, () => {}));
    await sleep(300);
    expect(idle.filter((c) => c.closed).length).toBeGreaterThanOrEqual(6);
    for (const c of idle) c.sock.destroy();
    await sleep(150);
    expect((await h.post(getAttrs())).status).toBe(200);
  });

  it("garbage bytes and bad Content-Length values do not crash the server", async () => {
    h = await startHarness();
    raw(h.port, (s) => s.write(Buffer.from([0, 1, 2, 255, 254, 13, 10, 13, 10])));
    raw(h.port, (s) => s.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: -5\r\n\r\n"));
    raw(h.port, (s) => s.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 99999999999999999999\r\n\r\n"));
    await sleep(150);
    expect((await h.post(getAttrs())).status).toBe(200);
  });
});
