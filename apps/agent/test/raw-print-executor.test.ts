import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildRawJob, canTransition, type JobState } from "@printio/shared";
import {
  RAW_CONNECT_TIMEOUT_MS,
  RAW_SUCCESS_STATUSES,
  RAW_WRITE_TIMEOUT_MS,
  executeRawPrint,
  sendRawBytes,
} from "../src/raw-print-executor.js";

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.destroy());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

async function listen(onConn: (s: net.Socket) => void) {
  const received: Buffer[] = [];
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.on("data", (d) => received.push(d));
    sock.on("close", () => resolveClosed());
    onConn(sock);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { port, received, closed };
}

const pdf = new TextEncoder().encode("%PDF-1.4 fake body");
const raw = (port: number) => ({
  host: "127.0.0.1",
  port,
  staplePosition: "top-left" as const,
  bindingSide: "left" as const,
  jobName: "My Job",
});
const req = { copies: 2, colorMode: "bw" as const, duplex: true, finishing: { staple: true, booklet: false, punch: false } };

describe("constants", () => {
  it("uses 15s connect and 120s write timeouts", () => {
    expect(RAW_CONNECT_TIMEOUT_MS).toBe(15_000);
    expect(RAW_WRITE_TIMEOUT_MS).toBe(120_000);
  });
});

describe("sendRawBytes", () => {
  it("delivers the exact bytes and resolves after the socket closes", async () => {
    const { port, received, closed } = await listen(() => {});
    const bytes = new Uint8Array([1, 2, 3, 250, 255, 0]);
    await sendRawBytes("127.0.0.1", port, bytes);
    await closed;
    expect(Buffer.concat(received).equals(Buffer.from(bytes))).toBe(true);
  });

  it("rejects when the connection is refused", async () => {
    const { port } = await listen(() => {});
    await new Promise((r) => servers.pop()!.close(() => r(undefined)));
    await expect(sendRawBytes("127.0.0.1", port, new Uint8Array([1]))).rejects.toThrow(/connect|refused/i);
  });

  it("rejects with a timeout when the connect never completes", async () => {
    // 10.255.255.1 is non-routable; if the network fails fast instead, still an error.
    await expect(
      sendRawBytes("10.255.255.1", 9100, new Uint8Array([1]), { connectTimeoutMs: 100 }),
    ).rejects.toThrow(/timed out|connect|unreach|EHOST|ENET/i);
  });

  it("rejects with a timeout when the peer stops reading (write never flushes)", async () => {
    const { port } = await listen((s) => s.pause());
    const big = new Uint8Array(64 * 1024 * 1024);
    await expect(sendRawBytes("127.0.0.1", port, big, { writeTimeoutMs: 200 })).rejects.toThrow(/timed out/i);
  });
});

describe("executeRawPrint", () => {
  it("sends exactly buildRawJob output built from the request options", async () => {
    const { port, received, closed } = await listen(() => {});
    const res = await executeRawPrint({ raw: raw(port), request: req, pdf });
    await closed;
    expect(res.ok).toBe(true);
    const expected = buildRawJob(
      { copies: 2, colorMode: "bw", duplex: true, jobName: "My Job", staple: "top-left", booklet: false, bindingSide: "left" },
      pdf,
    );
    if (!expected.ok) throw new Error("expected ok");
    expect(Buffer.concat(received).equals(Buffer.from(expected.bytes))).toBe(true);
  });

  it("returns ok:false with the reason and opens NO connection when buildRawJob refuses", async () => {
    let connections = 0;
    const { port } = await listen(() => {
      connections += 1;
    });
    // A right-binding booklet is supported now (KFOLD + SHORTEDGE, see pjl.ts), so use an
    // input buildRawJob still refuses: a booklet that also asks for a separate staple.
    const res = await executeRawPrint({
      raw: raw(port),
      request: { ...req, finishing: { staple: true, booklet: true, punch: false } },
      pdf,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/staple/);
    await new Promise((r) => setTimeout(r, 50));
    expect(connections).toBe(0);
  });

  it("returns ok:false (does not throw) when the printer is unreachable", async () => {
    const { port } = await listen(() => {});
    await new Promise((r) => servers.pop()!.close(() => r(undefined)));
    const res = await executeRawPrint({ raw: raw(port), request: req, pdf });
    expect(res.ok).toBe(false);
  });
});

describe("RAW_SUCCESS_STATUSES", () => {
  it("is a legal chain from 'printing' that ends in 'completed' (the cloud rejects skipping a state)", () => {
    let current: JobState = "printing";
    for (const next of RAW_SUCCESS_STATUSES) {
      expect(canTransition(current, next)).toBe(true);
      current = next;
    }
    expect(current).toBe("completed");
  });
});

describe("typed failures (what the orchestrator uses to decide wait vs fail)", () => {
  it("connection refused -> kind connect_refused, code ECONNREFUSED, never a bare string", async () => {
    const { port } = await listen(() => {});
    await new Promise((r) => servers.pop()!.close(() => r(undefined)));
    const res = await executeRawPrint({ raw: raw(port), request: req, pdf });
    expect(res).toMatchObject({ ok: false, failure: { kind: "connect_refused", code: "ECONNREFUSED" } });
  });

  it("peer that stops reading -> write_timeout, with how many bytes left this machine", async () => {
    const { port } = await listen((s) => s.pause());
    const res = await executeRawPrint({ raw: raw(port), request: req, pdf: new Uint8Array(64 * 1024 * 1024), timeouts: { writeTimeoutMs: 200 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure.kind).toBe("write_timeout");
      expect(typeof res.failure.bytesWritten).toBe("number");
      expect(res.reason).toMatch(/timed out/);
    }
  });

  it("buildRawJob refusing -> invalid_job (permanent) and no connection", async () => {
    const { port } = await listen(() => {});
    const res = await executeRawPrint({ raw: raw(port), request: { ...req, finishing: { staple: true, booklet: true, punch: false } }, pdf });
    expect(res).toMatchObject({ ok: false, failure: { kind: "invalid_job" } });
  });

  it("a document carrying a PJL escape sequence -> invalid_job, nothing is sent", async () => {
    const { port } = await listen(() => {});
    const evil = new TextEncoder().encode("%PDF-1.4\n\x1b%-12345X@PJL SET COPIES=99\n");
    const res = await executeRawPrint({ raw: raw(port), request: req, pdf: evil });
    expect(res).toMatchObject({ ok: false, failure: { kind: "invalid_job" } });
    if (!res.ok) expect(res.reason).toMatch(/printer control codes/);
  });

  it("success carries no failure", async () => {
    const { port, closed } = await listen(() => {});
    const res = await executeRawPrint({ raw: raw(port), request: req, pdf });
    await closed;
    expect(res.ok).toBe(true);
  });
});

describe("RAW_DEFERRED_STATUSES", () => {
  it("is the legal chain from 'claimed' to 'completed' (the job stays claimed while it is being sent so it can still be released)", async () => {
    const { RAW_DEFERRED_STATUSES } = await import("../src/raw-print-executor.js");
    let current: JobState = "claimed";
    for (const next of RAW_DEFERRED_STATUSES) {
      expect(canTransition(current, next), `${current} -> ${next}`).toBe(true);
      current = next;
    }
    expect(current).toBe("completed");
  });
});

describe("write timeout: did everything go out?", () => {
  it("peer that reads it all but never closes -> write_timeout with flushed=true (the printer may have the whole job)", async () => {
    const server = net.createServer({ allowHalfOpen: true }, (s) => {
      sockets.push(s);
      s.on("data", () => {});
      s.on("error", () => {});
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    const res = await executeRawPrint({ raw: raw(port), request: req, pdf, timeouts: { writeTimeoutMs: 300 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure).toMatchObject({ kind: "write_timeout", flushed: true });
      expect(res.reason).toMatch(/all data was sent but the printer did not confirm/);
    }
  });

  it("peer that stops reading a big job -> write_timeout, and 'flushed' says whether the OS took every byte", async () => {
    // Whether 64 MB fits in the loopback buffers is up to the OS (Windows swallows it), so only the shape is asserted here;
    // retry-policy.test.ts covers both values of `flushed`.
    const { port } = await listen((s) => s.pause());
    const res = await executeRawPrint({ raw: raw(port), request: req, pdf: new Uint8Array(64 * 1024 * 1024), timeouts: { writeTimeoutMs: 300 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure.kind).toBe("write_timeout");
      expect(typeof res.failure.flushed).toBe("boolean");
    }
  });
});
