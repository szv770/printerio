import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const requireSessionOrRedirect = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: () => requireSessionOrRedirect() }));
const db = vi.hoisted(() => ({ rateOk: true, upserts: [] as unknown[] }));
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => ({
    rpc: async () => ({ data: db.rateOk, error: null }),
    from: () => ({
      upsert: async (row: unknown) => {
        db.upserts.push(row);
        return { error: null };
      },
    }),
  }),
}));

import { importDailyAction } from "./daily-actions";

const dir = join(__dirname, "..", "..", "..", "..", "lib", "library", "daily", "fixtures");
const feedXml = readFileSync(join(dir, "dailystudy-rss-2026-11-01.xml"), "utf8");
const page = (name: string) => readFileSync(join(dir, name), "utf8");
const form = (date: string, files: Record<string, string>) => {
  const f = new FormData();
  f.set("date", date);
  for (const [name, body] of Object.entries(files)) f.append("files", new File([body], name, { type: "text/html" }));
  return f;
};
const admin = { userId: "u1", membership: { organization_id: "o1", role: "org_admin", early_tools: false } };

beforeEach(() => {
  vi.clearAllMocks();
  db.rateOk = true;
  db.upserts = [];
  requireSessionOrRedirect.mockResolvedValue(admin);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(feedXml, { status: 200, headers: { "content-type": "text/xml; charset=UTF-8" } })));
});

describe("importDailyAction", () => {
  it("saves pages that match the day's feed, one row per page", async () => {
    const res = await importDailyAction(form("2026-11-01", { "tanya.htm": page("study-tanya.html"), "rambam.htm": page("study-rambam1.html") }));
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.ok)).toEqual([true, true]);
    expect(db.upserts).toHaveLength(2);
    expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toBe("https://www.chabad.org/tools/rss/dailystudy_rss.xml?tdate=11/1/2026");
  });
  it("is for admins only", async () => {
    requireSessionOrRedirect.mockResolvedValue({ ...admin, membership: { ...admin.membership, role: "staff" } });
    const res = await importDailyAction(form("2026-11-01", { "t.htm": page("study-tanya.html") }));
    expect(res.ok).toBe(false);
    expect(db.upserts).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a bad date, no files, too many files, a huge file and a wrong file type", async () => {
    expect((await importDailyAction(form("11/1/2026", { "t.htm": "x" }))).ok).toBe(false);
    expect((await importDailyAction(form("2026-11-01", {}))).ok).toBe(false);
    const many = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`f${n}.htm`, "x"]));
    expect((await importDailyAction(form("2026-11-01", many))).ok).toBe(false);
    const huge = await importDailyAction(form("2026-11-01", { "big.htm": "x".repeat(4 * 1024 * 1024) }));
    expect(huge.results[0]?.ok).toBe(false);
    const wrong = await importDailyAction(form("2026-11-01", { "notes.pdf": "x" }));
    expect(wrong.results[0]?.ok).toBe(false);
    expect(db.upserts).toHaveLength(0);
  });
  it("refuses when Chabad.org's feed for that date is not the date asked for", async () => {
    const res = await importDailyAction(form("2026-11-09", { "t.htm": page("study-tanya.html") }));
    expect(res.ok).toBe(false);
    expect(db.upserts).toHaveLength(0);
  });
  it("tells the person when Chabad.org's feed cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Just a moment</html>", { status: 403, headers: { "content-type": "text/html" } })));
    const res = await importDailyAction(form("2026-11-01", { "t.htm": page("study-tanya.html") }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/list/i);
  });
  it("respects the rate limit", async () => {
    db.rateOk = false;
    expect((await importDailyAction(form("2026-11-01", { "t.htm": page("study-tanya.html") }))).ok).toBe(false);
  });
});
