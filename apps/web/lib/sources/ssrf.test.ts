import { describe, expect, it } from "vitest";
import { isBlockedAddress, isAllowedHostname } from "./ssrf";

describe("isBlockedAddress: nothing private, local or special may be fetched", () => {
  it.each([
    "0.0.0.0", "127.0.0.1", "127.255.255.254", "10.0.0.5", "10.255.255.255", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "192.0.0.1", "192.0.2.1", "198.18.0.1",
    "198.51.100.1", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  ])("blocks IPv4 %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "142.250.80.46", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "11.0.0.1"])(
    "allows public IPv4 %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  );

  it.each(["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::abcd:1%eth0", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2001:db8::1", "::ffff:7f00:1"])(
    "blocks IPv6 %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(true),
  );

  it.each(["2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8"])("allows public IPv6 %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it("blocks anything it cannot read as an address (fail closed)", () => {
    for (const bad of ["", "not-an-ip", "999.1.1.1", "1.2.3", "1.2.3.4.5", "::g", "12345::1"]) expect(isBlockedAddress(bad)).toBe(true);
  });

  it("blocks the decimal / hex / octal tricks for 127.0.0.1", () => {
    for (const bad of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1"]) expect(isBlockedAddress(bad)).toBe(true);
  });
});

describe("isAllowedHostname", () => {
  it("allows ordinary public hostnames", () => {
    for (const h of ["drive.google.com", "docs.google.com", "drive.usercontent.google.com", "www.hebrewbooks.org", "a-b.example.co.uk"]) expect(isAllowedHostname(h)).toBe(true);
  });
  it("refuses single-label names, local names, IP literals and odd characters", () => {
    for (const h of ["localhost", "intranet", "printer.local", "db.internal", "x.localhost", "127.0.0.1", "[::1]", "::1", "10.0.0.1", "exa mple.com", "a..b.com", "-a.com", "a.com.", "", "user@host.com", "host.com:8080"]) {
      expect(isAllowedHostname(h)).toBe(false);
    }
  });
});
