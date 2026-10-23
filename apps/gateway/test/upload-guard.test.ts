import { describe, expect, it } from "vitest";
import { UploadGuard } from "../src/upload-guard.js";

const MB = 1024 * 1024;

describe("UploadGuard", () => {
  it("lets uploads in until the byte cap would be exceeded, then says busy", () => {
    const g = new UploadGuard({ maxInflightBytes: 150 * MB, maxPerKey: 5 });
    const a = g.tryAcquire("dev1");
    const b = g.tryAcquire("dev2");
    const c = g.tryAcquire("dev3");
    expect(a && b && c).toBeTruthy();
    expect(a!.reserve(50 * MB)).toBe(true);
    expect(b!.reserve(50 * MB)).toBe(true);
    expect(c!.reserve(50 * MB)).toBe(true);
    expect(g.inflightBytes).toBe(150 * MB);
    const d = g.tryAcquire("dev4")!;
    expect(d.reserve(1)).toBe(false);
    expect(g.inflightBytes).toBe(150 * MB);
  });

  it("a refused reservation holds nothing (the lease is dead but still releasable)", () => {
    const g = new UploadGuard({ maxInflightBytes: 10, maxPerKey: 5 });
    const a = g.tryAcquire("a")!;
    a.reserve(8);
    const b = g.tryAcquire("b")!;
    expect(b.reserve(5)).toBe(false);
    expect(b.reserve(1)).toBe(false); // stays refused
    b.release();
    expect(g.inflightBytes).toBe(8);
    a.release();
    expect(g.inflightBytes).toBe(0);
    expect(g.activeUploads).toBe(0);
  });

  it("at most 2 concurrent uploads per device, other devices unaffected", () => {
    const g = new UploadGuard({ maxInflightBytes: 1000 * MB, maxPerKey: 2 });
    const a1 = g.tryAcquire("dev1");
    const a2 = g.tryAcquire("dev1");
    expect(a1 && a2).toBeTruthy();
    expect(g.tryAcquire("dev1")).toBeNull();
    expect(g.tryAcquire("dev2")).not.toBeNull();
    a1!.release();
    expect(g.tryAcquire("dev1")).not.toBeNull();
  });

  it("release is idempotent and the counters never go negative", () => {
    const g = new UploadGuard({ maxInflightBytes: 100, maxPerKey: 2 });
    const a = g.tryAcquire("x")!;
    a.reserve(60);
    a.release();
    a.release();
    a.release();
    expect(g.inflightBytes).toBe(0);
    expect(g.activeUploads).toBe(0);
    expect(g.activeFor("x")).toBe(0);
    const b = g.tryAcquire("x")!;
    b.reserve(100);
    expect(g.inflightBytes).toBe(100);
    b.release();
    expect(g.inflightBytes).toBe(0);
  });

  it("reserve() after release() is refused and cannot leak bytes", () => {
    const g = new UploadGuard({ maxInflightBytes: 100, maxPerKey: 2 });
    const a = g.tryAcquire("x")!;
    a.release();
    expect(a.reserve(10)).toBe(false);
    expect(g.inflightBytes).toBe(0);
  });

  it("chunked bodies grow the reservation as bytes arrive, and the cap is enforced mid-stream", () => {
    const g = new UploadGuard({ maxInflightBytes: 100, maxPerKey: 2 });
    const other = g.tryAcquire("o")!;
    other.reserve(60);
    const a = g.tryAcquire("a")!;
    expect(a.reserve(20)).toBe(true);
    expect(a.reserve(20)).toBe(true);
    expect(a.reserve(1)).toBe(false);
    expect(g.inflightBytes).toBe(60); // a's 40 were given back when it was refused
    expect(g.peakInflightBytes).toBe(100);
  });

  it("a thousand random acquire/reserve/release rounds always end at zero and never exceed either limit", () => {
    const g = new UploadGuard({ maxInflightBytes: 500, maxPerKey: 2 });
    const live: Array<ReturnType<UploadGuard["tryAcquire"]>> = [];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 1000; i += 1) {
      const r = rnd();
      if (r < 0.5) {
        const l = g.tryAcquire(`d${Math.floor(rnd() * 4)}`);
        if (l) {
          l.reserve(Math.floor(rnd() * 200));
          live.push(l);
        }
      } else if (live.length > 0) {
        live.splice(Math.floor(rnd() * live.length), 1)[0]!.release();
      }
      expect(g.inflightBytes).toBeGreaterThanOrEqual(0);
      expect(g.inflightBytes).toBeLessThanOrEqual(500);
      for (const k of ["d0", "d1", "d2", "d3"]) expect(g.activeFor(k)).toBeLessThanOrEqual(2);
    }
    for (const l of live) l!.release();
    expect(g.inflightBytes).toBe(0);
    expect(g.activeUploads).toBe(0);
  });
});
