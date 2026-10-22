import { describe, expect, it } from "vitest";
import {
  DEVICE_TOKEN_LENGTH,
  deviceHostname,
  generateDeviceToken,
  hashDeviceToken,
  isDeviceToken,
  tokenFromHost,
} from "./device-token";

describe("device tokens", () => {
  it("are 39 base32 characters and effectively unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = generateDeviceToken();
      expect(t).toHaveLength(DEVICE_TOKEN_LENGTH);
      expect(isDeviceToken(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });

  it("fits in one DNS label with the u- prefix", () => {
    const label = deviceHostname(generateDeviceToken(), "szvtech.org").split(".")[0]!;
    expect(label.length).toBe(41);
    expect(label.length).toBeLessThanOrEqual(63);
  });

  it("round-trips token -> hostname -> token -> stored hash", () => {
    const token = generateDeviceToken();
    const host = deviceHostname(token, "szvtech.org");
    const parsed = tokenFromHost(host, "szvtech.org");
    expect(parsed).toBe(token);
    expect(hashDeviceToken(parsed!)).toBe(hashDeviceToken(token));
  });

  it("parses Host headers with a port and any letter case", () => {
    const token = generateDeviceToken();
    expect(tokenFromHost(`U-${token.toUpperCase()}.SZVTECH.ORG:443`, "szvtech.org")).toBe(token);
  });

  it("rejects the wrong domain, wrong length, bad characters and a missing prefix", () => {
    const token = generateDeviceToken();
    expect(tokenFromHost(`u-${token}.example.com`, "szvtech.org")).toBeNull();
    expect(tokenFromHost(`u-${token}x.szvtech.org`, "szvtech.org")).toBeNull();
    expect(tokenFromHost(`u-${token.slice(1)}.szvtech.org`, "szvtech.org")).toBeNull();
    expect(tokenFromHost(`u-${"1".repeat(39)}.szvtech.org`, "szvtech.org")).toBeNull();
    expect(tokenFromHost(`${token}.szvtech.org`, "szvtech.org")).toBeNull();
    expect(tokenFromHost(`u-${token}.evil.szvtech.org.example`, "szvtech.org")).toBeNull();
    expect(tokenFromHost(undefined, "szvtech.org")).toBeNull();
  });

  it("hashes to 64 lowercase hex characters, deterministically", () => {
    const h = hashDeviceToken("a".repeat(39));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceToken("a".repeat(39))).toBe(h);
    expect(hashDeviceToken("b".repeat(39))).not.toBe(h);
  });
});
