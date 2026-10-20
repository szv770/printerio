import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildRawJob } from "@printio/shared";
import {
  RAW_CONNECT_TIMEOUT_MS,
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
