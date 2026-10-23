import { describe, expect, it } from "vitest";
import { StatusCache } from "../src/status-cache.js";
import type { JobInfo } from "../src/web-client.js";

const info = (status: JobInfo["status"], message?: string): JobInfo => ({ jobId: "w1", status, message });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

describe("StatusCache", () => {
  it("serves repeated polls from memory for 3 seconds, then asks again", async () => {
    let now = 10_000;
    const c = new StatusCache({ now: () => now });
    let calls = 0;
    const fetcher = async () => ((calls += 1), info("approved"));
    for (let i = 0; i < 10; i += 1) await c.get("w1", fetcher);
    expect(calls).toBe(1);
    now += 2_999;
    await c.get("w1", fetcher);
    expect(calls).toBe(1);
    now += 2;
    await c.get("w1", fetcher);
    expect(calls).toBe(2);
  });

  it("a once-a-second poller from 10 phones is ~10 web calls in 30 s, not 300", async () => {
    let now = 0;
    const c = new StatusCache({ now: () => now });
    let calls = 0;
    const fetcher = async () => ((calls += 1), info("approved"));
    for (let second = 0; second < 30; second += 1) {
      for (let phone = 0; phone < 10; phone += 1) await c.get(`w${phone}`, fetcher);
      now += 1000;
    }
    expect(calls).toBeLessThanOrEqual(10 * 10);
    expect(calls).toBeGreaterThanOrEqual(10 * 8);
  });

  it("concurrent polls for the same job share one web call", async () => {
    const c = new StatusCache();
    const gate = deferred<JobInfo | null>();
    let calls = 0;
    const fetcher = () => ((calls += 1), gate.promise);
    const all = [c.get("w1", fetcher), c.get("w1", fetcher), c.get("w1", fetcher)];
    gate.resolve(info("printing"));
    expect((await Promise.all(all)).map((i) => i?.status)).toEqual(["printing", "printing", "printing"]);
    expect(calls).toBe(1);
  });

  it("different jobs are cached separately", async () => {
    const c = new StatusCache();
    let calls = 0;
    await c.get("a", async () => ((calls += 1), info("approved")));
    await c.get("b", async () => ((calls += 1), info("completed")));
    expect(calls).toBe(2);
    expect((await c.get("b", async () => info("failed")))?.status).toBe("completed");
  });

  it("invalidate (cancel) forces the next read to go to the web app", async () => {
    const c = new StatusCache();
    let calls = 0;
    await c.get("w1", async () => ((calls += 1), info("approved")));
    c.invalidate("w1");
    const after = await c.get("w1", async () => ((calls += 1), info("cancelled")));
    expect(after?.status).toBe("cancelled");
    expect(calls).toBe(2);
  });

  it("a fetch that was already running when the job was cancelled cannot write its stale answer back", async () => {
    const c = new StatusCache();
    const gate = deferred<JobInfo | null>();
    const stale = c.get("w1", () => gate.promise);
    c.invalidate("w1");
    gate.resolve(info("approved")); // the old, pre-cancel answer
    await stale;
    expect(c.peek("w1")).toBeUndefined();
    const fresh = await c.get("w1", async () => info("cancelled"));
    expect(fresh?.status).toBe("cancelled");
  });

  it("errors are not cached and are seen by everyone who was waiting; the next call retries", async () => {
    const c = new StatusCache();
    const gate = deferred<JobInfo | null>();
    const a = c.get("w1", () => gate.promise);
    const b = c.get("w1", () => gate.promise);
    gate.reject(new Error("web down"));
    await expect(a).rejects.toThrow("web down");
    await expect(b).rejects.toThrow("web down");
    expect((await c.get("w1", async () => info("approved")))?.status).toBe("approved");
  });

  it("a 'not found' answer is cached briefly too (a phone polling a vanished job does not hammer the web app)", async () => {
    let now = 0;
    const c = new StatusCache({ now: () => now });
    let calls = 0;
    const gone = async () => ((calls += 1), null);
    expect(await c.get("w1", gone)).toBeNull();
    expect(await c.get("w1", gone)).toBeNull();
    expect(calls).toBe(1);
    now += 3_001;
    await c.get("w1", gone);
    expect(calls).toBe(2);
  });

  it("prime() seeds the cache from the finalize answer so the first poll costs nothing", async () => {
    const c = new StatusCache();
    c.prime("w1", info("approved"));
    let calls = 0;
    expect((await c.get("w1", async () => ((calls += 1), info("printing"))))?.status).toBe("approved");
    expect(calls).toBe(0);
  });

  it("memory is bounded", async () => {
    const c = new StatusCache({ maxEntries: 100 });
    for (let i = 0; i < 1000; i += 1) await c.get(`w${i}`, async () => info("approved"));
    expect(c.size).toBeLessThanOrEqual(100);
  });
});
