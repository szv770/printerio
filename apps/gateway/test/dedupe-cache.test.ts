import { describe, expect, it } from "vitest";
import { DedupeCache } from "../src/dedupe-cache.js";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

describe("DedupeCache", () => {
  it("sequential: the second identical request gets the first result without running the work again", async () => {
    const c = new DedupeCache<{ job: string }>({ now: () => 0 });
    let runs = 0;
    const work = async () => ((runs += 1), { job: `job-${runs}` });
    const a = await c.run("k", work);
    const b = await c.run("k", work);
    expect(runs).toBe(1);
    expect(a).toEqual({ value: { job: "job-1" }, deduped: false });
    expect(b).toEqual({ value: { job: "job-1" }, deduped: true });
  });

  it("concurrent: identical requests while the first is still running share ONE promise", async () => {
    const c = new DedupeCache<string>();
    const gate = deferred<string>();
    let runs = 0;
    const work = () => ((runs += 1), gate.promise);
    const p1 = c.run("k", work);
    const p2 = c.run("k", work);
    const p3 = c.run("k", work);
    gate.resolve("one job");
    const all = await Promise.all([p1, p2, p3]);
    expect(runs).toBe(1);
    expect(all.map((r) => r.value)).toEqual(["one job", "one job", "one job"]);
    expect(all.map((r) => r.deduped)).toEqual([false, true, true]);
  });

  it("different keys never share (different document, different device, different options)", async () => {
    const c = new DedupeCache<string>();
    let runs = 0;
    const work = (v: string) => async () => ((runs += 1), v);
    const r = await Promise.all([c.run("dev1:docA", work("a")), c.run("dev1:docB", work("b")), c.run("dev2:docA", work("c"))]);
    expect(runs).toBe(3);
    expect(r.map((x) => x.value)).toEqual(["a", "b", "c"]);
  });

  it("entries expire: after the window the same document is new work", async () => {
    let now = 1000;
    const c = new DedupeCache<number>({ ttlMs: 180_000, now: () => now });
    let runs = 0;
    const work = async () => ++runs;
    await c.run("k", work);
    now += 179_999;
    expect((await c.run("k", work)).deduped).toBe(true);
    now += 2;
    expect(await c.run("k", work)).toEqual({ value: 2, deduped: false });
  });

  it("a failed run does not poison the key: the very next request runs again and can succeed", async () => {
    const c = new DedupeCache<string>();
    let runs = 0;
    await expect(
      c.run("k", async () => {
        runs += 1;
        throw new Error("web down");
      }),
    ).rejects.toThrow("web down");
    expect(c.size).toBe(0);
    expect((await c.run("k", async () => ((runs += 1), "ok"))).value).toBe("ok");
    expect(runs).toBe(2);
    expect((await c.run("k", async () => "never")).deduped).toBe(true);
  });

  it("requests that joined a run that then failed all fail together, and the next one starts fresh", async () => {
    const c = new DedupeCache<string>();
    const gate = deferred<string>();
    const a = c.run("k", () => gate.promise);
    const b = c.run("k", () => gate.promise);
    gate.reject(new Error("boom"));
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
    expect((await c.run("k", async () => "again")).value).toBe("again");
  });

  it("only results the caller says are cacheable are remembered (a refusal is retried for real)", async () => {
    const c = new DedupeCache<{ ok: boolean }>();
    let runs = 0;
    const work = async () => ({ ok: ++runs > 1 });
    const opts = { cache: (v: { ok: boolean }) => v.ok };
    expect((await c.run("k", work, opts)).value.ok).toBe(false);
    expect((await c.run("k", work, opts)).value.ok).toBe(true);
    expect((await c.run("k", work, opts)).deduped).toBe(true);
    expect(runs).toBe(2);
  });

  it("a remembered result the caller no longer considers usable (job was cancelled) is replaced by new work", async () => {
    const c = new DedupeCache<{ job: string; cancelled: boolean }>();
    let runs = 0;
    const work = async () => ({ job: `j${++runs}`, cancelled: false });
    const first = await c.run("k", work);
    first.value.cancelled = true;
    const second = await c.run("k", work, { usable: (v) => !v.cancelled });
    expect(second).toMatchObject({ deduped: false, value: { job: "j2" } });
  });

  it("invalidate() drops matching entries (e.g. on cancel)", async () => {
    const c = new DedupeCache<{ job: string }>();
    await c.run("a", async () => ({ job: "1" }));
    await c.run("b", async () => ({ job: "2" }));
    c.invalidate((v) => v.job === "1");
    expect(c.size).toBe(1);
    expect((await c.run("a", async () => ({ job: "3" }))).deduped).toBe(false);
  });

  it("memory is bounded: LRU cap evicts the least recently used SETTLED entry", async () => {
    const c = new DedupeCache<number>({ maxEntries: 3 });
    for (const k of ["a", "b", "c"]) await c.run(k, async () => 1);
    await c.run("a", async () => 99); // touch a -> b is now the oldest
    await c.run("d", async () => 1);
    expect(c.size).toBe(3);
    expect((await c.run("b", async () => 2)).deduped).toBe(false); // evicted
    expect((await c.run("a", async () => 2)).deduped).toBe(true); // kept
  });

  it("an in-flight entry is never evicted to make room (would allow a duplicate)", async () => {
    const c = new DedupeCache<number>({ maxEntries: 2 });
    const gate = deferred<number>();
    let slowRuns = 0;
    const slow = c.run("slow", () => ((slowRuns += 1), gate.promise));
    await c.run("x", async () => 1);
    await c.run("y", async () => 1);
    await c.run("z", async () => 1);
    const again = c.run("slow", () => ((slowRuns += 1), gate.promise));
    gate.resolve(5);
    expect((await Promise.all([slow, again])).map((r) => r.value)).toEqual([5, 5]);
    expect(slowRuns).toBe(1);
  });

  it("hammering many distinct keys never grows past the cap", async () => {
    const c = new DedupeCache<number>({ maxEntries: 50 });
    for (let i = 0; i < 2000; i += 1) await c.run(`k${i}`, async () => i);
    expect(c.size).toBeLessThanOrEqual(50);
  });
});
