import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { executeRawPrint, feedbackCapMs, listenCapMs, type PrinterVerdict } from "../src/raw-print-executor.js";

// A fake printer that replays the byte formats MEASURED on the TASKalfa MZ8500i (docs/kyocera-raw-print.md).
const START = '@PJL USTATUS JOB\r\nSTART\r\nNAME="My Job"\r\n\f';
const page = (n: number) => `@PJL USTATUS PAGE\r\n${n}\n\r\n\f`;
const device = (code: number, text: string) => `@PJL USTATUS DEVICE\r\nCODE=${code}\r\nDISPLAY="${text}"\r\nONLINE=TRUE\r\n\f`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.destroy());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

interface Fake {
  port: number;
  received: Buffer[];
  state: { ended: boolean; closed: boolean; endedAtFirstMessage?: boolean };
}
/** `script` runs once the printer has received the job's first bytes; it can write to / close the socket. */
async function fakePrinter(script: (sock: net.Socket, fake: Fake) => Promise<void> | void): Promise<Fake> {
  const fake: Fake = { port: 0, received: [], state: { ended: false, closed: false } };
  let started = false;
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.on("data", (d) => {
      fake.received.push(d);
      if (!started) {
        started = true;
        void script(sock, fake);
      }
    });
    sock.on("end", () => (fake.state.ended = true));
    sock.on("close", () => (fake.state.closed = true));
    sock.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  fake.port = (server.address() as net.AddressInfo).port;
  return fake;
}

const pdf = new TextEncoder().encode("%PDF-1.4 fake body");
const raw = (port: number) => ({ host: "127.0.0.1", port, staplePosition: "top-left" as const, bindingSide: "left" as const, jobName: "My Job" });
const req = { copies: 2, colorMode: "bw" as const, duplex: true, finishing: { staple: false, booklet: false, punch: false } };
const fast = { destroyAfterMs: 40 };

async function run(fake: Fake, feedback: Parameters<typeof executeRawPrint>[0]["feedback"]): Promise<PrinterVerdict> {
  const r = await executeRawPrint({ raw: raw(fake.port), request: req, pdf, feedback });
  if (!r.ok) throw new Error(`send failed: ${r.reason}`);
  if (!r.printerOutcome) throw new Error("no printerOutcome");
  return r.printerOutcome;
}

describe("printer feedback: the bytes", () => {
  it("asks for USTATUS reports before the JOB line when feedback is on, never when it is off", async () => {
    const on = await fakePrinter(async (s) => {
      s.write(page(1));
    });
    await run(on, { expectedSheets: 1, ...fast });
    const sent = Buffer.concat(on.received).toString("latin1");
    expect(sent.indexOf("@PJL USTATUS PAGE=ON")).toBeGreaterThan(0);
    expect(sent.indexOf("@PJL USTATUS PAGE=ON")).toBeLessThan(sent.indexOf("@PJL JOB NAME"));

    const off = await fakePrinter((s) => void s.end());
    const r = await executeRawPrint({ raw: raw(off.port), request: req, pdf });
    expect(r.ok && r.printerOutcome).toBeFalsy();
    expect(Buffer.concat(off.received).toString("latin1")).not.toContain("USTATUS");
  });
});

describe("printer feedback: the printer remembers USTATUS settings, so we put them back", () => {
  // Measured 2026-11-01: PAGE=ON / TIMED=5 / DEVICE=VERBOSE stay set on the Kyocera after our job, and every later connection
  // (including the agent's own status checks) then receives stray PAGE and TIMED messages.
  it("writes the restore commands (DEVICE=ON, JOB=ON, PAGE=OFF, TIMED=0) on our own connection before closing, after a confirmed job", async () => {
    const fake = await fakePrinter(async (s) => {
      s.write(START + page(1) + page(2) + page(3) + page(4));
    });
    const verdict = await run(fake, { expectedSheets: 4, ...fast });
    expect(verdict).toMatchObject({ outcome: "confirmed" });
    await sleep(150);
    const all = Buffer.concat(fake.received).toString("latin1");
    const tail = all.slice(all.lastIndexOf("@PJL EOJ"));
    expect(tail).toContain("@PJL USTATUS PAGE=OFF");
    expect(tail).toContain("@PJL USTATUS TIMED=0");
    expect(tail).toContain("@PJL USTATUS DEVICE=ON");
  });

  it("also restores them when the printer stays quiet (a stall)", async () => {
    const fake = await fakePrinter(async (s) => {
      s.write(START);
    });
    const verdict = await run(fake, { expectedSheets: 4, stallMs: 120, ...fast });
    expect(verdict).toMatchObject({ outcome: "unconfirmed", reason: "stalled" });
    await sleep(150);
    expect(Buffer.concat(fake.received).toString("latin1")).toContain("@PJL USTATUS PAGE=OFF");
  });
});

describe("printer feedback: confirmed", () => {
  it("several PAGE messages in one chunk and one split mid-message: confirmed 4 of 4, our side stays open until then, then end() and destroy()", async () => {
    const fake = await fakePrinter(async (s, f) => {
      await sleep(30);
      s.write(START + device(10023, "Processing..."));
      await sleep(30);
      s.write(page(1) + page(2));
      await sleep(30);
      const tail = page(3) + page(4);
      s.write(tail.slice(0, 20));
      await sleep(30);
      f.state.endedAtFirstMessage = f.state.ended; // must still be false: we did not half-close after the data
      s.write(tail.slice(20));
    });
    const verdict = await run(fake, { expectedSheets: 4, ...fast });
    expect(verdict).toEqual({ outcome: "confirmed", sheets: 4, expected: 4 });
    expect(fake.state.endedAtFirstMessage).toBe(false);
    await sleep(150);
    expect(fake.state.ended).toBe(true); // end() was sent
    expect(fake.state.closed).toBe(true); // and the socket was destroyed shortly after
  });

  it("a sheet total above the expected number still counts as confirmed", async () => {
    const fake = await fakePrinter((s) => void s.write(page(1) + page(2) + page(3)));
    expect(await run(fake, { expectedSheets: 2, ...fast })).toMatchObject({ outcome: "confirmed", sheets: 3, expected: 2 });
  });

  it("reports progress as sheets arrive", async () => {
    const fake = await fakePrinter(async (s) => {
      await sleep(20);
      s.write(page(1));
      await sleep(20);
      s.write(page(2));
    });
    const seen: number[] = [];
    await run(fake, { expectedSheets: 2, ...fast, onUpdate: (u) => seen.push(u.sheets) });
    expect(seen).toEqual([1, 2]);
  });
});

describe("printer feedback: fallback to 'sent' (today's behaviour)", () => {
  it("a stall (printer goes quiet) is 'unconfirmed', never a failure", async () => {
    const fake = await fakePrinter(async (s) => {
      s.write(START + page(1));
    });
    const verdict = await run(fake, { expectedSheets: 3, stallMs: 150, capMs: 5000, ...fast });
    expect(verdict).toEqual({ outcome: "unconfirmed", reason: "stalled", sheets: 1, expected: 3 });
    await sleep(120);
    expect(fake.state.closed).toBe(true);
  });

  it("TIMED device repeats do not keep a stalled job alive", async () => {
    const fake = await fakePrinter(async (s) => {
      for (let i = 0; i < 20; i++) {
        s.write(device(10023, "Processing..."));
        await sleep(30);
      }
    });
    const verdict = await run(fake, { expectedSheets: 2, stallMs: 150, capMs: 5000, ...fast });
    expect(verdict).toMatchObject({ outcome: "unconfirmed", reason: "stalled", sheets: 0 });
  });

  it("the printer closes right after receiving the data and says nothing: unconfirmed, the job counts as sent", async () => {
    const fake = await fakePrinter((s) => void s.end());
    const verdict = await run(fake, { expectedSheets: 2, ...fast });
    expect(verdict).toMatchObject({ outcome: "unconfirmed", reason: "closed", sheets: 0 });
  });

  it("a connection reset mid-way is unconfirmed, and keeps the sheets seen so far", async () => {
    const fake = await fakePrinter(async (s) => {
      s.write(page(1));
      await sleep(40);
      s.resetAndDestroy();
    });
    const verdict = await run(fake, { expectedSheets: 3, ...fast });
    expect(verdict).toMatchObject({ outcome: "unconfirmed", sheets: 1, expected: 3 });
  });

  it("the overall cap ends a job that keeps sending device messages but never a sheet", async () => {
    const fake = await fakePrinter(async (s) => {
      for (let i = 0; i < 30; i++) {
        s.write(device(10023, "Processing..."));
        await sleep(20);
      }
    });
    const verdict = await run(fake, { expectedSheets: 2, stallMs: 5000, capMs: 200, ...fast });
    expect(verdict).toMatchObject({ outcome: "unconfirmed", reason: "cap" });
  });

  it("garbage from the printer is ignored", async () => {
    const fake = await fakePrinter(async (s) => {
      s.write(Buffer.from([0, 255, 254, 7, 12, 0x40]));
      s.write("@PJL USTATUS");
      await sleep(30);
      s.write(page(1));
    });
    expect(await run(fake, { expectedSheets: 1, ...fast })).toMatchObject({ outcome: "confirmed" });
  });
});

describe("printer feedback: the printer needs attention", () => {
  it("an attention code is surfaced; the job keeps waiting through the stall window and ends 'attention' at the cap", async () => {
    const updates: Array<string | undefined> = [];
    const fake = await fakePrinter(async (s) => {
      s.write(START + page(1) + device(40022, "Paper jam"));
    });
    const t0 = Date.now();
    const verdict = await run(fake, { expectedSheets: 3, stallMs: 300, capMs: 700, ...fast, onUpdate: (u) => updates.push(u.attention?.text) });
    expect(verdict).toEqual({ outcome: "attention", sheets: 1, expected: 3, code: 40022, text: "Paper jam" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600); // waited past the 300 ms stall window
    expect(updates).toContain("Paper jam");
  });

  it("attention that clears (10xxx again) and then finishes is confirmed", async () => {
    const fake = await fakePrinter(async (s) => {
      s.write(device(40022, "Paper jam"));
      await sleep(60);
      s.write(device(10023, "Processing...") + page(1) + page(2));
    });
    expect(await run(fake, { expectedSheets: 2, stallMs: 300, capMs: 3000, ...fast })).toMatchObject({ outcome: "confirmed", sheets: 2 });
  });

  it("attention that clears and then goes quiet falls back to unconfirmed, not attention", async () => {
    const fake = await fakePrinter(async (s) => {
      s.write(device(40022, "Paper jam"));
      await sleep(40);
      s.write(device(10001, "Ready."));
    });
    expect(await run(fake, { expectedSheets: 2, stallMs: 150, capMs: 3000, ...fast })).toMatchObject({ outcome: "unconfirmed", reason: "stalled" });
  });

  it("a close while attention is showing is reported as attention", async () => {
    const fake = await fakePrinter(async (s) => {
      s.write(device(40022, "Paper jam"));
      await sleep(40);
      s.end();
    });
    expect(await run(fake, { expectedSheets: 2, ...fast })).toMatchObject({ outcome: "attention", text: "Paper jam" });
  });
});

describe("printer feedback: failures before the data is out are still send failures", () => {
  it("connection refused rejects like a normal send (the orchestrator then waits for the printer)", async () => {
    const probe = await fakePrinter(() => {});
    const port = probe.port;
    await new Promise((r) => servers.pop()!.close(() => r(undefined)));
    const r = await executeRawPrint({ raw: raw(port), request: req, pdf, feedback: { expectedSheets: 1, ...fast } });
    expect(r).toMatchObject({ ok: false, failure: { kind: "connect_refused" } });
  });
});

describe("listenCapMs", () => {
  it("60 s plus 6 s per sheet, never more than 30 minutes", () => {
    expect(listenCapMs(1)).toBe(66_000);
    expect(listenCapMs(10)).toBe(120_000);
    expect(listenCapMs(100_000)).toBe(30 * 60_000);
  });
});

describe("feedbackCapMs (never listen past the job's lease)", () => {
  const now = 1_000_000;
  it("normal job with a fresh 10 minute lease: the scaling cap", () => {
    expect(feedbackCapMs(10, new Date(now + 600_000).toISOString(), now)).toBe(120_000);
  });
  it("held to the lease minus a 60 s margin", () => {
    expect(feedbackCapMs(10, new Date(now + 100_000).toISOString(), now)).toBe(40_000);
  });
  it("less than 30 s of lease left after the margin: no feedback (null)", () => {
    expect(feedbackCapMs(10, new Date(now + 85_000).toISOString(), now)).toBeNull();
    expect(feedbackCapMs(10, new Date(now - 5_000).toISOString(), now)).toBeNull();
  });
  it("an unreadable lease: no feedback", () => {
    expect(feedbackCapMs(10, "nonsense", now)).toBeNull();
  });
});
