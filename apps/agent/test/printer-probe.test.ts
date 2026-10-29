import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probePrinter } from "../src/printer-probe.js";

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.destroy());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

async function fakePrinter(onData: (data: string, sock: net.Socket) => void) {
  const received: string[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.on("data", (d) => {
      received.push(d.toString("latin1"));
      onData(d.toString("latin1"), sock);
    });
    sock.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as net.AddressInfo).port, received };
}

const answer = (code: number, display: string, online = true) => `@PJL INFO STATUS\r\nCODE=${code}\r\nDISPLAY="${display}"\r\nONLINE=${online ? "TRUE" : "FALSE"}\r\n\f`;

describe("probePrinter (asks the printer how it is, without printing anything)", () => {
  it("sends only a status question, and reads the answer", async () => {
    const p = await fakePrinter((data, sock) => {
      if (data.includes("@PJL INFO STATUS")) sock.write(answer(10023, "Processing..."));
    });
    const res = await probePrinter({ host: "127.0.0.1", port: p.port }, { timeoutMs: 2000 });
    expect(res).toEqual({ reachable: true, answered: true, online: true, code: 10023, display: "Processing..." });
    const sent = p.received.join("");
    expect(sent).toContain("@PJL INFO STATUS");
    expect(sent).not.toMatch(/ENTER LANGUAGE|%PDF|@PJL SET/); // never anything that could print or change settings
  });

  it("reports a problem message and an offline printer as the printer says them", async () => {
    const p = await fakePrinter((_d, sock) => sock.write(answer(40022, "Add paper in cassette 2", false)));
    expect(await probePrinter({ host: "127.0.0.1", port: p.port }, { timeoutMs: 2000 })).toMatchObject({ answered: true, online: false, code: 40022, display: "Add paper in cassette 2" });
  });

  it("a printer that accepts the connection but never answers is reachable but not answered, after the time limit", async () => {
    const p = await fakePrinter(() => undefined);
    const t0 = Date.now();
    expect(await probePrinter({ host: "127.0.0.1", port: p.port }, { timeoutMs: 400 })).toEqual({ reachable: true, answered: false });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a printer that refuses the connection is not reachable, and the probe never throws", async () => {
    const p = await fakePrinter(() => undefined);
    const port = p.port;
    await new Promise((r) => servers[0]!.close(() => r(undefined)));
    expect(await probePrinter({ host: "127.0.0.1", port }, { timeoutMs: 1000 })).toEqual({ reachable: false, answered: false });
  });

  it("handles an answer that arrives in pieces", async () => {
    const p = await fakePrinter((_d, sock) => {
      const text = answer(10001, "Ready");
      sock.write(text.slice(0, 20));
      setTimeout(() => sock.write(text.slice(20)), 50);
    });
    expect(await probePrinter({ host: "127.0.0.1", port: p.port }, { timeoutMs: 2000 })).toMatchObject({ answered: true, code: 10001, display: "Ready" });
  });
});
