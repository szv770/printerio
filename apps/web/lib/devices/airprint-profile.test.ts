import { describe, expect, it } from "vitest";
import { buildAirPrintProfile, isDeviceHostname } from "./airprint-profile";

const HOST = "u-abcdefghijklmnopqrstuvwxyz234567abcdefg.szvtech.org";
const ids = { content: "11111111-1111-4111-8111-111111111111", profile: "22222222-2222-4222-8222-222222222222" };

describe("buildAirPrintProfile", () => {
  const xml = buildAirPrintProfile({ hostname: HOST, displayName: "Printio-MLMI-SZV", uuids: ids });
  it("is an Apple configuration profile with one AirPrint payload pointing at the gateway path over TLS", () => {
    expect(xml).toContain("<?xml");
    expect(xml).toContain("<key>PayloadType</key><string>com.apple.airprint</string>");
    expect(xml).toContain("<key>PayloadType</key><string>Configuration</string>");
    expect(xml).toContain(`<key>IPAddress</key><string>${HOST}</string>`);
    expect(xml).toContain("<key>ResourcePath</key><string>ipp/print</string>");
    expect(xml).toContain("<key>Port</key><integer>443</integer>");
    expect(xml).toContain("<key>ForceTLS</key><true/>");
  });
  it("uses the given UUIDs and a readable name", () => {
    expect(xml).toContain(ids.content);
    expect(xml).toContain(ids.profile);
    expect(xml).toContain("<string>Printio-MLMI-SZV</string>");
  });
  it("escapes XML in the display name and rejects a hostname that is not a device address", () => {
    expect(buildAirPrintProfile({ hostname: HOST, displayName: "A <b> & \"c\"", uuids: ids })).toContain("A &lt;b&gt; &amp; &quot;c&quot;");
    expect(() => buildAirPrintProfile({ hostname: "evil.example.com", displayName: "x", uuids: ids })).toThrow();
    expect(() => buildAirPrintProfile({ hostname: "u-abc.szvtech.org", displayName: "x", uuids: ids })).toThrow();
  });
});

describe("isDeviceHostname", () => {
  it("accepts u-<39 base32 chars>.<domain> and nothing else", () => {
    expect(isDeviceHostname(HOST)).toBe(true);
    expect(isDeviceHostname(HOST.toUpperCase())).toBe(false);
    expect(isDeviceHostname("u-short.szvtech.org")).toBe(false);
    expect(isDeviceHostname(`${HOST}/ipp/print`)).toBe(false);
    expect(isDeviceHostname(`https://${HOST}`)).toBe(false);
    expect(isDeviceHostname("")).toBe(false);
  });
});
