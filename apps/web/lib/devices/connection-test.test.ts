import { describe, expect, it } from "vitest";
import { connectionVerdictBadge, parseConnectionReport, probeHostFor, summarizeConnectionTest, type ConnectionReport } from "./connection-test";

const ok = (ms = 120) => ({ ok: true, ms });
const bad = (ms = 8000) => ({ ok: false, ms });
const report = (over: Partial<ConnectionReport> = {}): ConnectionReport => ({ control: ok(), probe: ok(), real: ok(), ...over });

describe("summarizeConnectionTest", () => {
  it("reachable: both addresses answer", () => {
    const s = summarizeConnectionTest(report());
    expect(s.verdict).toBe("reachable");
    expect(s.tone).toBe("success");
  });
  it("offline: even our own site did not answer, so nothing else can be concluded", () => {
    const s = summarizeConnectionTest(report({ control: bad(), probe: bad(), real: bad() }));
    expect(s.verdict).toBe("offline");
  });
  it("address_blocked: the short test address works but the personal one does not (filters that dislike long random names)", () => {
    const s = summarizeConnectionTest(report({ real: bad() }));
    expect(s.verdict).toBe("address_blocked");
    expect(s.advice).toMatch(/another network|hotspot/i);
  });
  it("domain_blocked: our site works but no szvtech.org print address does", () => {
    const s = summarizeConnectionTest(report({ probe: bad(), real: bad() }));
    expect(s.verdict).toBe("domain_blocked");
    expect(s.advice).toMatch(/szvtech\.org/);
  });
  it("mixed: only the personal address works", () => {
    expect(summarizeConnectionTest(report({ probe: bad() })).verdict).toBe("mixed");
  });
  it("is plain words and never contains the address", () => {
    for (const r of [report(), report({ real: bad() }), report({ probe: bad(), real: bad() })]) {
      const s = summarizeConnectionTest(r);
      expect(s.title.length).toBeGreaterThan(5);
      expect(`${s.title} ${s.advice}`).not.toMatch(/https?:|u-[a-z2-7]{20}/);
    }
  });
});

describe("parseConnectionReport", () => {
  it("accepts the expected shape and clamps timings", () => {
    const r = parseConnectionReport({ control: { ok: true, ms: 40.7 }, probe: { ok: false, ms: 99999999 }, real: { ok: true, ms: -5 } });
    expect(r).toEqual({ control: { ok: true, ms: 41 }, probe: { ok: false, ms: 60000 }, real: { ok: true, ms: 0 } });
  });
  it("rejects anything else: missing parts, wrong types, and extra fields are dropped", () => {
    expect(parseConnectionReport(null)).toBeNull();
    expect(parseConnectionReport({ control: { ok: true, ms: 1 } })).toBeNull();
    expect(parseConnectionReport({ control: { ok: "yes", ms: 1 }, probe: ok(), real: ok() })).toBeNull();
    const withExtra = parseConnectionReport({ control: ok(), probe: ok(), real: ok(), hostname: "u-secret.szvtech.org", note: "x" });
    expect(withExtra).toEqual(report());
    expect(JSON.stringify(withExtra)).not.toContain("secret");
  });
});

describe("probeHostFor", () => {
  it("is a short, token-free sibling of the device hostname", () => {
    expect(probeHostFor("u-3kq9x7m2v5p8d4n6h1j0b7c2w9t5r8y4e6a1sz3.szvtech.org")).toBe("ct-probe.szvtech.org");
  });
  it("returns null for something that is not a hostname with a domain", () => {
    expect(probeHostFor("localhost")).toBeNull();
    expect(probeHostFor("")).toBeNull();
  });
});

describe("connectionVerdictBadge", () => {
  it("has a short admin label and tone for every verdict", () => {
    expect(connectionVerdictBadge("reachable")).toEqual({ label: "Network OK", tone: "success" });
    for (const v of ["offline", "address_blocked", "domain_blocked", "mixed"] as const) {
      const b = connectionVerdictBadge(v);
      expect(b.label.length).toBeGreaterThan(3);
      expect(b.tone).toBe("warning");
    }
    expect(connectionVerdictBadge("address_blocked").label).toMatch(/blocked/i);
  });
});
