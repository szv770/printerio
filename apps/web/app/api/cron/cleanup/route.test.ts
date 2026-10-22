import { beforeEach, describe, expect, it, vi } from "vitest";

const sweepRetention = vi.fn();
const sweepOrphans = vi.fn();
const pruneHousekeeping = vi.fn();
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => ({ marker: "service" }) }));
vi.mock("@/lib/retention", () => ({ sweepRetention: (...a: unknown[]) => sweepRetention(...a) }));
vi.mock("@/lib/cleanup", () => ({
  sweepOrphans: (...a: unknown[]) => sweepOrphans(...a),
  pruneHousekeeping: (...a: unknown[]) => pruneHousekeeping(...a),
}));

import { GET } from "./route";

const SECRET = "x".repeat(32);
const req = (auth?: string) => new Request("http://x/api/cron/cleanup", { headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
  process.env.PRINTIO_CRON_SECRET = SECRET;
  sweepRetention.mockReset().mockResolvedValue({ filesDeleted: 4, jobsPurged: 3 });
  sweepOrphans.mockReset().mockResolvedValue({ intakeDeleted: 1, jobOrphansDeleted: 2, orphanPaths: [], truncated: false });
  pruneHousekeeping.mockReset().mockResolvedValue({ remoteCommandsDeleted: 5 });
});

describe("GET /api/cron/cleanup", () => {
  it("rejects a missing secret", async () => {
    expect((await GET(req())).status).toBe(401);
    expect(sweepRetention).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    expect((await GET(req("Bearer nope"))).status).toBe(401);
    expect(sweepOrphans).not.toHaveBeenCalled();
  });

  it("runs retention, orphan sweep and housekeeping and reports counts", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toMatchObject({ filesDeleted: 4, jobsPurged: 3, intakeDeleted: 1, jobOrphansDeleted: 2, remoteCommandsDeleted: 5 });
    expect(sweepRetention).toHaveBeenCalledTimes(1);
  });

  it("still returns 200 with a note if one step throws, so the others' work is reported", async () => {
    sweepOrphans.mockRejectedValue(new Error("boom"));
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).errors).toEqual(["orphans: boom"]);
    expect(pruneHousekeeping).toHaveBeenCalled();
  });
});
