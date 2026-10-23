import { describe, expect, it } from "vitest";
import { checkRawTarget, parseRawAllowedHosts } from "../src/raw-host-policy.js";

const noDns = async (): Promise<string[]> => {
  throw new Error("no dns expected");
};
const dnsTo = (...addrs: string[]) => async () => addrs;

describe("checkRawTarget", () => {
  it("accepts the owner's printer", async () => {
    const r = await checkRawTarget({ host: "192.168.100.168", port: 9100 }, { lookup: noDns });
    expect(r).toEqual({ ok: true, host: "192.168.100.168", port: 9100 });
  });

  it.each(["10.0.0.5", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.0.1"])("accepts private LAN %s", async (host) => {
    expect((await checkRawTarget({ host, port: 9100 }, { lookup: noDns })).ok).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "169.254.0.1",
    "224.0.0.1",
    "239.255.255.250",
    "255.255.255.255",
    "0.0.0.0",
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "100.64.0.1",
    "11.0.0.1",
  ])("refuses %s", async (host) => {
    const r = await checkRawTarget({ host, port: 9100 }, { lookup: noDns });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/private network address/i);
  });

  it("refuses IPv6 and localhost", async () => {
    expect((await checkRawTarget({ host: "::1", port: 9100 }, { lookup: noDns })).ok).toBe(false);
    expect((await checkRawTarget({ host: "fe80::1", port: 9100 }, { lookup: noDns })).ok).toBe(false);
    expect((await checkRawTarget({ host: "localhost", port: 9100 }, { lookup: dnsTo("127.0.0.1") })).ok).toBe(false);
  });

  it.each([0, -1, 65536, 1.5, NaN])("refuses port %s", async (port) => {
    const r = await checkRawTarget({ host: "192.168.1.1", port }, { lookup: noDns });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/port/i);
  });

  it("accepts the edge ports 1 and 65535", async () => {
    expect((await checkRawTarget({ host: "192.168.1.1", port: 1 }, { lookup: noDns })).ok).toBe(true);
    expect((await checkRawTarget({ host: "192.168.1.1", port: 65535 }, { lookup: noDns })).ok).toBe(true);
  });

  it("resolves a hostname and returns the resolved address to connect to (no DNS re-resolve)", async () => {
    const r = await checkRawTarget({ host: "printer.school.lan", port: 9100 }, { lookup: dnsTo("10.1.2.3") });
    expect(r).toEqual({ ok: true, host: "10.1.2.3", port: 9100 });
  });

  it("refuses a hostname that resolves to a public, loopback or metadata address, even if only one answer is bad", async () => {
    for (const bad of ["8.8.8.8", "127.0.0.1", "169.254.169.254"]) {
      expect((await checkRawTarget({ host: "x.example", port: 9100 }, { lookup: dnsTo("10.1.2.3", bad) })).ok).toBe(false);
    }
  });

  it("refuses non-canonical IPv4 spellings that resolve to a forbidden address", async () => {
    for (const host of ["2130706433", "0x7f.1", "0177.0.0.1", "127.1"]) {
      expect((await checkRawTarget({ host, port: 9100 }, { lookup: dnsTo("127.0.0.1") })).ok, host).toBe(false);
    }
  });

  it("refuses when the name does not resolve", async () => {
    const r = await checkRawTarget({ host: "nope.invalid", port: 9100 }, {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not find/i);
  });

  it("refuses a name that resolves to nothing", async () => {
    expect((await checkRawTarget({ host: "empty.lan", port: 9100 }, { lookup: dnsTo() })).ok).toBe(false);
  });

  describe("allow-list", () => {
    const allow = parseRawAllowedHosts(" 192.168.100.168 , Printer.School.lan ,");
    it("parses a comma separated list, trimming and lower-casing", () => {
      expect(allow).toEqual(["192.168.100.168", "printer.school.lan"]);
      expect(parseRawAllowedHosts(undefined)).toBeUndefined();
      expect(parseRawAllowedHosts("  ")).toBeUndefined();
    });
    it("allows only listed hosts when set", async () => {
      expect((await checkRawTarget({ host: "192.168.100.168", port: 9100 }, { lookup: noDns, allowedHosts: allow })).ok).toBe(true);
      const r = await checkRawTarget({ host: "192.168.100.169", port: 9100 }, { lookup: noDns, allowedHosts: allow });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/PRINTIO_RAW_ALLOWED_HOSTS/);
    });
    it("matches a listed hostname case-insensitively, and still checks what it resolves to", async () => {
      expect((await checkRawTarget({ host: "PRINTER.school.LAN", port: 9100 }, { lookup: dnsTo("10.0.0.9"), allowedHosts: allow })).ok).toBe(true);
      expect((await checkRawTarget({ host: "printer.school.lan", port: 9100 }, { lookup: dnsTo("8.8.8.8"), allowedHosts: allow })).ok).toBe(false);
    });
    it("a listed public address is still refused", async () => {
      expect((await checkRawTarget({ host: "8.8.8.8", port: 9100 }, { lookup: noDns, allowedHosts: ["8.8.8.8"] })).ok).toBe(false);
    });
  });
});
