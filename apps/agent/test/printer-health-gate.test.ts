import { describe, expect, it, vi } from "vitest";
import type { PrinterProbeFacts } from "@printio/shared";
import { createLogger } from "../src/logger.js";
import { PRINTER_PROBLEM_SENTENCE, SUSPECT_CAP_MS, createPrinterHealthGate, judgeProbe } from "../src/printer-health-gate.js";

const logger = createLogger({ level: "error" });
const target = { host: "192.168.100.168", port: 9100 };
const KEY = "192.168.100.168:9100";
const facts = (o: Partial<PrinterProbeFacts> = {}): PrinterProbeFacts => ({ reachable: true, answered: true, online: true, code: 10001, display: "Ready.", ...o });

describe("judgeProbe", () => {
  it("ready, processing, sleeping and a code-less answer are healthy", () => {
    expect(judgeProbe(facts()).healthy).toBe(true);
    expect(judgeProbe(facts({ code: 10023, display: "Processing..." })).healthy).toBe(true);
    expect(judgeProbe(facts({ code: 35078, display: "Sleeping..." })).healthy).toBe(true);
    expect(judgeProbe(facts({ code: undefined })).healthy).toBe(true);
  });
  it("any other code, offline, silence and an unreachable port are not healthy", () => {
    expect(judgeProbe(facts({ code: 15141, display: "Folding tray full" })).healthy).toBe(false);
    expect(judgeProbe(facts({ code: 40022 })).healthy).toBe(false);
    expect(judgeProbe(facts({ code: 63001 })).healthy).toBe(false);
    expect(judgeProbe(facts({ online: false })).healthy).toBe(false);
    expect(judgeProbe({ reachable: true, answered: false }).healthy).toBe(false);
    expect(judgeProbe({ reachable: false, answered: false }).healthy).toBe(false);
  });
});

describe("createPrinterHealthGate", () => {
  it("a printer that is not suspect is allowed with no probe call", async () => {
    const probe = vi.fn(async () => facts({ code: 63001 }));
    const gate = createPrinterHealthGate({ logger, probe });
    expect(await gate.check(KEY, target)).toEqual({ allow: true });
    expect(probe).not.toHaveBeenCalled();
  });

  it("suspect + error blocks with the plain sentence; the first healthy read clears the mark", async () => {
    let answer = facts({ code: 63001, display: "System error" });
    const probe = vi.fn(async () => answer);
    const gate = createPrinterHealthGate({ logger, probe });
    gate.markSuspect(KEY);
    const blocked = await gate.check(KEY, target);
    expect(blocked.allow).toBe(false);
    expect(blocked.allow === false && blocked.reason).toContain(PRINTER_PROBLEM_SENTENCE);
    expect(gate.isSuspect(KEY)).toBe(true);
    answer = facts();
    expect(await gate.check(KEY, target)).toEqual({ allow: true });
    expect(gate.isSuspect(KEY)).toBe(false);
    expect(await gate.check(KEY, target)).toEqual({ allow: true });
    expect(probe).toHaveBeenCalledTimes(2); // nothing after the mark was cleared
  });

  it("silence is retried once, then counts as not healthy; an answer on the retry is healthy", async () => {
    const silent = vi.fn(async (): Promise<PrinterProbeFacts> => ({ reachable: false, answered: false }));
    const g1 = createPrinterHealthGate({ logger, probe: silent, retryDelayMs: 0 });
    g1.markSuspect(KEY);
    expect((await g1.check(KEY, target)).allow).toBe(false);
    expect(silent).toHaveBeenCalledTimes(2);

    const flaky = vi.fn<() => Promise<PrinterProbeFacts>>().mockResolvedValueOnce({ reachable: true, answered: false }).mockResolvedValue(facts());
    const g2 = createPrinterHealthGate({ logger, probe: flaky, retryDelayMs: 0 });
    g2.markSuspect(KEY);
    expect((await g2.check(KEY, target)).allow).toBe(true);
  });

  it("a probe that throws fails open and clears the mark", async () => {
    const gate = createPrinterHealthGate({
      logger,
      probe: async () => {
        throw new Error("boom");
      },
    });
    gate.markSuspect(KEY);
    expect(await gate.check(KEY, target)).toEqual({ allow: true });
    expect(gate.isSuspect(KEY)).toBe(false);
  });

  it("the mark is dropped after the cap even if the printer still reads bad (with no probe call)", async () => {
    let now = 1_000;
    const probe = vi.fn(async () => facts({ code: 63001 }));
    const gate = createPrinterHealthGate({ logger, probe, now: () => now });
    gate.markSuspect(KEY);
    expect((await gate.check(KEY, target)).allow).toBe(false);
    now += SUSPECT_CAP_MS;
    expect(await gate.check(KEY, target)).toEqual({ allow: true });
    expect(gate.isSuspect(KEY)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("markHealthy (a confirmed job) clears the mark; marks are per printer", async () => {
    const probe = vi.fn(async () => facts({ code: 63001 }));
    const gate = createPrinterHealthGate({ logger, probe });
    gate.markSuspect(KEY);
    gate.markSuspect("10.0.0.9:9100");
    gate.markHealthy(KEY);
    expect(await gate.check(KEY, target)).toEqual({ allow: true });
    expect((await gate.check("10.0.0.9:9100", { host: "10.0.0.9", port: 9100 })).allow).toBe(false);
  });
});
