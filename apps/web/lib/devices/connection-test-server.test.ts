import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { saveConnectionTest } from "./connection-test-server";

const GOOD = { control: { ok: true, ms: 50 }, probe: { ok: true, ms: 80 }, real: { ok: false, ms: 8000 } };
const IDS = { deviceId: "d1", userId: "u1", organizationId: "o1" };

function fakeDb(opts: { device?: { id: string } | null; limited?: boolean; insertError?: boolean } = {}) {
  const inserts: Record<string, unknown>[] = [];
  const deviceFilters: Array<[string, unknown]> = [];
  const db = {
    rpc: vi.fn(async () => ({ data: !opts.limited, error: null })),
    from(table: string) {
      if (table === "member_devices") {
        const q = {
          select: () => q,
          eq: (c: string, v: unknown) => (deviceFilters.push([c, v]), q),
          maybeSingle: async () => ({ data: "device" in opts ? opts.device : { id: "d1" }, error: null }),
        };
        return q;
      }
      return {
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: opts.insertError ? { message: "boom" } : null };
        },
      };
    },
  };
  return { db: db as never, inserts, deviceFilters };
}

describe("saveConnectionTest", () => {
  it("stores the verdict worked out on the server, scoped to the member's own device, with no address in the row", async () => {
    const f = fakeDb();
    const res = await saveConnectionTest(f.db, { ...IDS, report: GOOD, userAgent: "Mozilla/5.0 test" });
    expect(res).toEqual({ ok: true, verdict: "address_blocked" });
    expect(f.deviceFilters).toEqual([["id", "d1"], ["user_id", "u1"], ["organization_id", "o1"]]);
    expect(f.inserts[0]).toMatchObject({ device_id: "d1", organization_id: "o1", user_id: "u1", verdict: "address_blocked", real_ok: false, user_agent: "Mozilla/5.0 test" });
    expect(JSON.stringify(f.inserts[0])).not.toMatch(/szvtech|https?:/);
  });
  it("ignores a verdict or extra fields sent by the browser", async () => {
    const f = fakeDb();
    await saveConnectionTest(f.db, { ...IDS, report: { ...GOOD, verdict: "reachable", hostname: "u-x.szvtech.org" }, userAgent: null });
    expect(f.inserts[0]).toMatchObject({ verdict: "address_blocked", user_agent: null });
    expect(f.inserts[0]).not.toHaveProperty("hostname");
  });
  it("refuses a device that is not theirs, a malformed report, and a flood", async () => {
    expect((await saveConnectionTest(fakeDb({ device: null }).db, { ...IDS, report: GOOD, userAgent: null })).ok).toBe(false);
    const bad = fakeDb();
    expect((await saveConnectionTest(bad.db, { ...IDS, report: { nope: 1 }, userAgent: null })).ok).toBe(false);
    expect(bad.inserts).toHaveLength(0);
    const limited = fakeDb({ limited: true });
    const res = await saveConnectionTest(limited.db, { ...IDS, report: GOOD, userAgent: null });
    expect(res.ok).toBe(false);
    expect(limited.inserts).toHaveLength(0);
  });
  it("truncates a long User-Agent and reports a failed insert plainly", async () => {
    const f = fakeDb();
    await saveConnectionTest(f.db, { ...IDS, report: GOOD, userAgent: "x".repeat(500) });
    expect((f.inserts[0]!.user_agent as string).length).toBe(300);
    expect(await saveConnectionTest(fakeDb({ insertError: true }).db, { ...IDS, report: GOOD, userAgent: null })).toEqual({ ok: false, error: "Could not save the test result." });
  });
});
