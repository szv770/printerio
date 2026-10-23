import { describe, expect, it } from "vitest";
import { clientIpFor, RateLimiter } from "../src/request-limits.js";

describe("RateLimiter", () => {
  it("allows max hits per window per key, then refuses, then recovers", () => {
    let t = 0;
    const rl = new RateLimiter({ max: 3, windowMs: 1000, now: () => t });
    expect([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, true, false]);
    expect(rl.take("b")).toBe(true); // other keys are independent
    t += 1001;
    expect(rl.take("a")).toBe(true);
  });
  it("isLimited does not consume", () => {
    const rl = new RateLimiter({ max: 1, windowMs: 1000, now: () => 0 });
    expect(rl.isLimited("a")).toBe(false);
    expect(rl.isLimited("a")).toBe(false);
    rl.take("a");
    expect(rl.isLimited("a")).toBe(true);
  });
  it("stays bounded under a flood of distinct keys", () => {
    const rl = new RateLimiter({ max: 5, windowMs: 60_000, now: () => 0, maxKeys: 100 });
    for (let i = 0; i < 10_000; i++) rl.take(`k${i}`);
    expect(rl.size).toBeLessThanOrEqual(100);
  });
});

describe("clientIpFor", () => {
  const loop = ["127.0.0.1", "::1"];
  it("uses CF-Connecting-IP only when the peer is a trusted proxy", () => {
    expect(clientIpFor("127.0.0.1", { "cf-connecting-ip": "203.0.113.9" }, loop)).toBe("203.0.113.9");
    expect(clientIpFor("::ffff:127.0.0.1", { "cf-connecting-ip": "203.0.113.9" }, loop)).toBe("203.0.113.9");
    expect(clientIpFor("::1", { "cf-connecting-ip": "2001:db8::1" }, loop)).toBe("2001:db8::1");
  });
  it("ignores the header from any other peer (spoofing)", () => {
    expect(clientIpFor("198.51.100.7", { "cf-connecting-ip": "203.0.113.9" }, loop)).toBe("198.51.100.7");
    expect(clientIpFor("::ffff:198.51.100.7", { "cf-connecting-ip": "203.0.113.9" }, loop)).toBe("198.51.100.7");
  });
  it("falls back to the peer when the header is junk or repeated", () => {
    expect(clientIpFor("127.0.0.1", { "cf-connecting-ip": "not an ip" }, loop)).toBe("127.0.0.1");
    expect(clientIpFor("127.0.0.1", { "cf-connecting-ip": "1.1.1.1, 2.2.2.2" }, loop)).toBe("127.0.0.1");
    expect(clientIpFor("127.0.0.1", {}, loop)).toBe("127.0.0.1");
    expect(clientIpFor(undefined, {}, loop)).toBe("unknown");
  });
  it("trusts nothing when the trusted list is empty", () => {
    expect(clientIpFor("127.0.0.1", { "cf-connecting-ip": "203.0.113.9" }, [])).toBe("127.0.0.1");
  });
});
