import { describe, expect, it } from "vitest";
import { narrowProbeReports, printerUpdateFromReport, rawPrinterTargets } from "./probe-report";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const own = new Set([ID]);
const NOW = "2026-10-28T12:00:00.000Z";

describe("narrowProbeReports (an agent's report about its printers is untrusted)", () => {
  it("keeps a well-formed report about the agent's own printer, with the display text cleaned", () => {
    expect(narrowProbeReports([{ printerId: ID, reachable: true, answered: true, online: true, code: 40022, display: "Add\u0007 paper" }], own)).toEqual([
      { printerId: ID, reachable: true, answered: true, online: true, code: 40022, display: "Add paper" },
    ]);
  });
  it("drops reports about printers that are not this agent's, and malformed ones", () => {
    const bad = [
      { printerId: OTHER, reachable: true, answered: true },
      { printerId: "not-a-uuid", reachable: true, answered: true },
      { printerId: ID, reachable: "yes", answered: true },
      { printerId: ID, reachable: true },
      null,
      "text",
      42,
    ];
    expect(narrowProbeReports(bad, own)).toEqual([]);
  });
  it("ignores nonsense codes, keeps only the first report per printer, and caps the list", () => {
    expect(narrowProbeReports([{ printerId: ID, reachable: true, answered: true, code: 123456789 }], own)[0]).not.toHaveProperty("code");
    expect(narrowProbeReports([{ printerId: ID, reachable: true, answered: false }, { printerId: ID, reachable: false, answered: false }], own)).toHaveLength(1);
    const many = Array.from({ length: 100 }, () => ({ printerId: ID, reachable: true, answered: false }));
    expect(narrowProbeReports(many, own).length).toBeLessThanOrEqual(20);
    expect(narrowProbeReports(undefined, own)).toEqual([]);
    expect(narrowProbeReports({}, own)).toEqual([]);
  });
});

describe("printerUpdateFromReport (what is written about the printer)", () => {
  const r = (over: Record<string, unknown>) => ({ printerId: ID, reachable: true, answered: true, ...over }) as Parameters<typeof printerUpdateFromReport>[0];
  it("a working printer is online, and its own words and code are kept", () => {
    expect(printerUpdateFromReport(r({ online: true, code: 10001, display: "Ready" }), NOW)).toEqual({ status: "online", status_detail: "Ready", status_code: 10001, last_status_at: NOW });
  });
  it("a printer that needs someone is an error, with what it says", () => {
    expect(printerUpdateFromReport(r({ code: 40022, display: "Add paper in cassette 2" }), NOW)).toMatchObject({ status: "error", status_detail: "Add paper in cassette 2" });
  });
  it("an offline or unreachable printer is offline, with a plain detail when the printer says nothing", () => {
    expect(printerUpdateFromReport(r({ online: false, code: 10002 }), NOW)).toMatchObject({ status: "offline" });
    expect(printerUpdateFromReport(r({ reachable: false, answered: false }), NOW)).toMatchObject({ status: "offline", status_detail: "Printio cannot reach the printer", status_code: null });
  });
  it("a printer that connects but stays silent is left as it was (nothing proven), only noting when it was checked", () => {
    expect(printerUpdateFromReport(r({ answered: false }), NOW)).toEqual({ last_status_at: NOW });
  });
});

describe("rawPrinterTargets (which printers an agent should ask about)", () => {
  it("lists the agent's direct-port printers once each, and skips profiles without an address", () => {
    const rows = [
      { printer_id: ID, output_mode: "raw", raw_host: "192.168.100.168", raw_port: 9100 },
      { printer_id: ID, output_mode: "raw", raw_host: "192.168.100.168", raw_port: 9100 },
      { printer_id: OTHER, output_mode: "queue", raw_host: null, raw_port: 9100 },
      { printer_id: "33333333-3333-4333-8333-333333333333", output_mode: "raw", raw_host: null, raw_port: 9100 },
    ];
    expect(rawPrinterTargets(rows)).toEqual([{ printerId: ID, host: "192.168.100.168", port: 9100 }]);
  });
});
