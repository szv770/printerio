import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { executeRawPrint, feedbackCapMs, listenCapMs, type PrinterVerdict } from "../src/raw-print-executor.js";
import { isSending } from "../src/send-activity.js";

// A fake printer that behaves like the TASKalfa MZ8500i did when measured (docs/kyocera-raw-print.md): the job connection is
// closed at once on FIN; every later short connection that asks INFO STATUS gets the scripted reply for that poll.
const END = (name: string, pages: number) => `@PJL USTATUS JOB\r\nEND\r\nNAME="${name}"\r\nPAGES=${pages}\r\n\f`;
const page = (n: number) => `@PJL USTATUS PAGE\r\n${n}\n\r\n\f`;
const device = (code: number, text: string) => `@PJL USTATUS DEVICE\r\nCODE=${code}\r\nDISPLAY="${text}"\r\nONLINE=TRUE\r\n\f`;
const info = (code: number, text: string) => `@PJL INFO STATUS\r\nCODE=${code}\r\nDISPLAY="${text}"\r\nONLINE=TRUE\r\n\f`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.destroy());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

interface Fake {
  port: number;
  job: Buffer[];
  jobEnded: boolean;
  polls: Buffer[];
  /** Our unique PJL job name, read from the job's bytes. */
  name(): string;
}
/** `reply(pollIndex, ourName)` returns the bytes written for that poll (empty = nothing). The first connection is the job. */
async function fakePrinter(reply: (poll: number, name: string) => string, port = 0, firstIsJob = true): Promise<Fake> {
  const fake: Fake = {
    port,
    job: [],
    jobEnded: false,
    polls: [],
    name: () => /@PJL JOB NAME="([^"]*)"/.exec(Buffer.concat(fake.job).toString("latin1"))?.[1] ?? "",
  };
  let conns = 0;
  const server = net.createServer((sock) => {
    sockets.push(sock);
    const isJob = firstIsJob && conns++ === 0;
    sock.on("data", (d) => {
      if (isJob) {
        fake.job.push(d);
        return;
      }
      if (!d.toString("latin1").includes("INFO STATUS")) return;
      const i = fake.polls.length;
      fake.polls.push(d);
      const out = reply(i, fake.name());
      if (out) sock.write(out, "latin1");
    });
    sock.on("end", () => {
      if (isJob) {
        fake.jobEnded = true;
        sock.end(); // closes on FIN, says nothing
      }
    });
    sock.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  fake.port = (server.address() as net.AddressInfo).port;
  return fake;
}

const pdf = new TextEncoder().encode("%PDF-1.4 fake body");
const raw = (port: number) => ({ host: "127.0.0.1", port, staplePosition: "top-left" as const, bindingSide: "left" as const, jobName: "My Job" });
const req = { copies: 2, colorMode: "bw" as const, duplex: true, finishing: { staple: false, booklet: false, punch: false } };
const fast = { pollIntervalMs: 30, readMs: 60 };
type Feedback = NonNullable<Parameters<typeof executeRawPrint>[0]["feedback"]>;

async function run(fake: Fake, feedback: Feedback): Promise<PrinterVerdict> {
  const r = await executeRawPrint({ raw: raw(fake.port), request: req, pdf, feedback });
  if (!r.ok) throw new Error(`send failed: ${r.reason}`);
  if (!r.printerOutcome) throw new Error("no printerOutcome");
  return r.printerOutcome;
}

describe("printer feedback: the job is sent exactly like the normal path", () => {
  it("data then FIN (no open job socket), only USTATUS JOB=ON and DEVICE=ON, never PAGE/TIMED/VERBOSE, no restore commands", async () => {
    const fake = await fakePrinter(() => "");
    await run(fake, { expectedPages: 1, capMs: 120, ...fast });
    const sent = Buffer.concat(fake.job).toString("latin1");
    expect(sent).toContain("@PJL USTATUS JOB=ON\r\n@PJL USTATUS DEVICE=ON\r\n@PJL JOB NAME=");
    expect(sent).not.toMatch(/PAGE=|TIMED|VERBOSE|=OFF/);
    expect(sent.match(/@PJL USTATUS/g)).toHaveLength(2); // nothing after the job either
    expect(fake.jobEnded).toBe(true);
  });

  it("off: no USTATUS, no polling, no printerOutcome", async () => {
    const fake = await fakePrinter(() => "");
    const r = await executeRawPrint({ raw: raw(fake.port), request: req, pdf });
    expect(r.ok && r.printerOutcome).toBeFalsy();
    await sleep(100);
    expect(Buffer.concat(fake.job).toString("latin1")).not.toContain("USTATUS");
    expect(fake.polls).toHaveLength(0);
  });

  it("gives the job a unique name: title + token (the same title twice differs); the token survives a long title", async () => {
    const a = await fakePrinter(() => "");
    await run(a, { expectedPages: 1, jobToken: "a1b2c3d4", capMs: 80, ...fast });
    expect(a.name()).toBe("My Job a1b2c3d4");
    const b = await fakePrinter(() => "");
    await run(b, { expectedPages: 1, capMs: 80, ...fast });
    const c = await fakePrinter(() => "");
    await run(c, { expectedPages: 1, capMs: 80, ...fast });
    expect(b.name()).toMatch(/^My Job [0-9a-z]{6,}$/);
    expect(b.name()).not.toBe(c.name());

    const d = await fakePrinter(() => "");
    const long = await executeRawPrint({ raw: { ...raw(d.port), jobName: "x".repeat(90) }, request: req, pdf, feedback: { expectedPages: 1, jobToken: "a1b2c3d4", capMs: 80, ...fast } });
    if (long.ok && long.printerOutcome) await long.printerOutcome;
    expect(d.name().length).toBe(60);
    expect(d.name().endsWith(" a1b2c3d4")).toBe(true);
  });
});

describe("printer feedback: polling with fresh short connections", () => {
  it("nothing for a while, then PAGE messages + our JOB END (+ a leftover END of another job) in one reply: confirmed N of N", async () => {
    const fake = await fakePrinter((i, name) => {
      if (i < 3) return "";
      return page(7) + page(8) + END("Older job 99999999", 12) + END(name, 8) + device(10001, "Ready.");
    });
    let early: PrinterVerdict | undefined;
    const p = run(fake, { expectedPages: 8, capMs: 3000, ...fast });
    void p.then((v) => (early = v));
    await sleep(80);
    expect(early).toBeUndefined(); // silence is not an answer
    expect(await p).toEqual({ outcome: "confirmed", pages: 8, expected: 8 });
    expect(fake.polls.length).toBeGreaterThanOrEqual(4);
    const esc = String.fromCharCode(27);
    expect(fake.polls[0]!.toString("latin1")).toBe(`${esc}%-12345X@PJL\r\n@PJL INFO STATUS\r\n@PJL INFO PAGECOUNT\r\n${esc}%-12345X`);
  });

  it("the END split over two polls is put together", async () => {
    const fake = await fakePrinter((i, name) => {
      const end = END(name, 4);
      if (i === 1) return end.slice(0, 25);
      if (i === 2) return end.slice(25);
      return "";
    });
    expect(await run(fake, { expectedPages: 4, capMs: 3000, ...fast })).toEqual({ outcome: "confirmed", pages: 4, expected: 4 });
  });

  it("a previous job's leftover END arriving first (other name, even with enough pages) is ignored", async () => {
    const fake = await fakePrinter((i, name) => (i === 0 ? END("Previous job 12345678", 5) + page(5) : i === 2 ? END(name, 5) : ""));
    let early: PrinterVerdict | undefined;
    const p = run(fake, { expectedPages: 5, capMs: 3000, ...fast });
    void p.then((v) => (early = v));
    await sleep(70);
    expect(early).toBeUndefined();
    expect(await p).toMatchObject({ outcome: "confirmed", pages: 5, expected: 5 });
  });

  it("END with fewer pages than expected: not confirmed, needs a person, honest text", async () => {
    const fake = await fakePrinter((i, name) => (i === 1 ? END(name, 6) : ""));
    expect(await run(fake, { expectedPages: 8, capMs: 3000, ...fast })).toEqual({
      outcome: "attention",
      pages: 6,
      expected: 8,
      text: "The printer finished the job but reported only 6 of 8 pages",
    });
  });

  it("an attention code is surfaced; polling continues to the cap, then 'attention' (never a resend)", async () => {
    const updates: Array<string | undefined> = [];
    const fake = await fakePrinter(() => info(40022, "Paper jam"));
    const t0 = Date.now();
    const verdict = await run(fake, { expectedPages: 3, capMs: 500, ...fast, onUpdate: (u) => updates.push(u.attention?.text) });
    expect(verdict).toEqual({ outcome: "attention", pages: 0, expected: 3, code: 40022, text: "Paper jam" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
    expect(updates).toContain("Paper jam");
    expect(fake.polls.length).toBeGreaterThan(3);
  });

  it("attention that clears and then our END arrives is confirmed", async () => {
    const fake = await fakePrinter((i, name) => (i === 0 ? device(40022, "Paper jam") : i === 2 ? info(10023, "Processing...") + END(name, 2) : ""));
    expect(await run(fake, { expectedPages: 2, capMs: 3000, ...fast })).toMatchObject({ outcome: "confirmed" });
  });

  it("10023 Processing and 35078 Sleeping are never a problem and never 'done'", async () => {
    const fake = await fakePrinter((i) => (i % 2 === 0 ? info(10023, "Processing...") : info(35078, "Sleeping...")));
    expect(await run(fake, { expectedPages: 2, capMs: 300, ...fast })).toMatchObject({ outcome: "unconfirmed", reason: "cap", pages: 0 });
  });

  it("the printer never answering: the cap ends it as 'unconfirmed' (counts as sent, not a failure)", async () => {
    const fake = await fakePrinter(() => "");
    const t0 = Date.now();
    const verdict = await run(fake, { expectedPages: 2, capMs: 250, ...fast });
    expect(verdict).toEqual({ outcome: "unconfirmed", reason: "cap", pages: 0, expected: 2 });
    expect(Date.now() - t0).toBeLessThan(1500);
    const n = fake.polls.length;
    await sleep(150);
    expect(fake.polls.length).toBe(n); // polling stopped
  });

  it("garbage from the printer is ignored", async () => {
    const fake = await fakePrinter((i, name) => (i === 0 ? "\u0000ÿ@PJL USTAT" : i === 1 ? END(name, 1) : ""));
    expect(await run(fake, { expectedPages: 1, capMs: 3000, ...fast })).toMatchObject({ outcome: "confirmed" });
  });

  it("connection refused during a poll: keep polling", async () => {
    const fake = await fakePrinter(() => "");
    const port = fake.port;
    const p = run(fake, { expectedPages: 2, capMs: 3000, ...fast });
    // the printer drops off the network right after the job, then comes back and finishes
    await sleep(40);
    await new Promise((r) => servers.pop()!.close(() => r(undefined)));
    sockets.splice(0).forEach((s) => s.destroy());
    await sleep(150);
    await fakePrinter(() => END(fake.name(), 2), port, false);
    expect(await p).toMatchObject({ outcome: "confirmed", pages: 2, expected: 2 });
  });
});

describe("printer feedback: the agent's own status probe stays off the printer until the verdict", () => {
  it("isSending() is true from the send until the verdict is reached (the probe is skipped meanwhile), false after", async () => {
    const fake = await fakePrinter((i, name) => (i === 3 ? END(name, 1) : ""));
    expect(isSending()).toBe(false);
    const r = await executeRawPrint({ raw: raw(fake.port), request: req, pdf, feedback: { expectedPages: 1, capMs: 3000, ...fast } });
    if (!r.ok || !r.printerOutcome) throw new Error("send failed");
    expect(isSending()).toBe(true); // the send is over but we are still waiting for our JOB END
    await sleep(60);
    expect(isSending()).toBe(true);
    await r.printerOutcome;
    expect(isSending()).toBe(false);
  });

  it("is released at the cap too", async () => {
    const fake = await fakePrinter(() => "");
    const r = await executeRawPrint({ raw: raw(fake.port), request: req, pdf, feedback: { expectedPages: 1, capMs: 100, ...fast } });
    if (!r.ok || !r.printerOutcome) throw new Error("send failed");
    await r.printerOutcome;
    expect(isSending()).toBe(false);
  });

  it("a failed send does not hold it", async () => {
    const probe = await fakePrinter(() => "");
    const port = probe.port;
    await new Promise((r) => servers.pop()!.close(() => r(undefined)));
    const r = await executeRawPrint({ raw: raw(port), request: req, pdf, feedback: { expectedPages: 1, ...fast } });
    expect(r).toMatchObject({ ok: false, failure: { kind: "connect_refused" } });
    expect(isSending()).toBe(false);
  });
});

describe("listenCapMs", () => {
  it("60 s plus 1.5 s per page, never more than 30 minutes", () => {
    expect(listenCapMs(2)).toBe(63_000);
    expect(listenCapMs(100)).toBe(210_000);
    expect(listenCapMs(100_000)).toBe(30 * 60_000);
  });
});

describe("feedbackCapMs (never wait past the job's lease)", () => {
  const now = 1_000_000;
  it("normal job with a fresh 10 minute lease: the scaling cap", () => {
    expect(feedbackCapMs(10, new Date(now + 600_000).toISOString(), now)).toBe(75_000);
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

import { feedbackPollDelayMs } from "../src/raw-print-executor.js";

describe("printer feedback: keep the number of connections to the printer small", () => {
  // Every connection may show up as an entry in the printer's own job log, so a job is checked a handful of times, not dozens.
  it("waits before the first check (longer for bigger jobs), then checks every 10 s, easing off to 20 s", () => {
    expect(feedbackPollDelayMs(0, 8)).toBeGreaterThanOrEqual(10_000);
    expect(feedbackPollDelayMs(0, 8)).toBeLessThanOrEqual(15_000);
    expect(feedbackPollDelayMs(0, 400)).toBeGreaterThan(feedbackPollDelayMs(0, 8));
    expect(feedbackPollDelayMs(0, 4000)).toBeLessThanOrEqual(60_000); // never wait more than a minute between checks
    expect(feedbackPollDelayMs(1, 8)).toBe(10_000);
    expect(feedbackPollDelayMs(3, 8)).toBe(10_000);
    expect(feedbackPollDelayMs(8, 8)).toBe(20_000);
  });

  it("a normal 8-page job is checked at most ~4 times in its first 50 seconds", () => {
    let t = 0;
    let n = 0;
    for (let i = 0; ; i++) {
      t += feedbackPollDelayMs(i, 8);
      if (t > 50_000) break;
      n++;
    }
    expect(n).toBeLessThanOrEqual(4);
  });
});

describe("printer feedback: the page counter (INFO PAGECOUNT works on any short connection, at any time)", () => {
  // Measured 2026-11-01: the Kyocera pushes its JOB END message only to a connection that is open at that moment, so a few
  // short checks usually miss it. The total page counter, however, can be read whenever we ask: it rose by exactly the pages printed.
  const pc = (n: number) => `@PJL INFO PAGECOUNT\r\n${n}\r\n\f`;

  it("reads the counter before sending and confirms once it has risen by at least the expected pages", async () => {
    const fake = await fakePrinter((i) => (i <= 1 ? pc(100) : pc(108)), 0, false); // check 0 = the baseline read, 1 = job not finished yet
    const v = await run(fake, { expectedPages: 8, countBaseline: true, ...fast });
    expect(v).toEqual({ outcome: "confirmed", pages: 8, expected: 8 });
  });

  it("every status check also asks for the counter (one connection, two questions)", async () => {
    const fake = await fakePrinter(() => pc(100), 0, false);
    await run(fake, { expectedPages: 8, countBaseline: true, capMs: 150, ...fast });
    const asked = fake.polls[0]!.toString("latin1");
    expect(asked).toContain("@PJL INFO STATUS");
    expect(asked).toContain("@PJL INFO PAGECOUNT");
  });

  it("a counter that rises by less than expected is not a confirmation (unconfirmed at the cap, with how far it got)", async () => {
    const fake = await fakePrinter((i) => (i === 0 ? pc(100) : pc(103)), 0, false);
    const v = await run(fake, { expectedPages: 8, countBaseline: true, capMs: 200, ...fast });
    expect(v).toEqual({ outcome: "unconfirmed", reason: "cap", pages: 3, expected: 8 });
  });

  it("someone else printing at the same time can only make it look further along (it still needs the expected pages)", async () => {
    const fake = await fakePrinter((i) => (i === 0 ? pc(100) : pc(112)), 0, false);
    const v = await run(fake, { expectedPages: 8, countBaseline: true, ...fast });
    expect(v).toMatchObject({ outcome: "confirmed", expected: 8 });
  });

  it("no baseline (the printer did not answer the first read): the counter is not used, nothing is invented", async () => {
    const fake = await fakePrinter((i) => (i === 0 ? "" : pc(500)), 0, false);
    const v = await run(fake, { expectedPages: 8, countBaseline: true, capMs: 200, ...fast });
    expect(v).toMatchObject({ outcome: "unconfirmed", reason: "cap" });
  });

  it("a counter that goes backwards (printer restarted) is ignored", async () => {
    const fake = await fakePrinter((i) => (i === 0 ? pc(1000) : pc(5)), 0, false);
    const v = await run(fake, { expectedPages: 2, countBaseline: true, capMs: 200, ...fast });
    expect(v).toMatchObject({ outcome: "unconfirmed" });
  });
});
