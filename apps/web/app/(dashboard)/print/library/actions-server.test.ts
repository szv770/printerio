import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "@/test/memory-db";

vi.mock("server-only", () => ({}));
const requireSessionOrRedirect = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSessionOrRedirect: () => requireSessionOrRedirect() }));
const dbBox = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient: () => dbBox.client }));
const loaders = vi.hoisted(() => ({
  loadLikkutVolume: vi.fn(async () => ({ ok: true as const, page: { volumes: [], current: null, parshiyos: [] } })),
  loadList: vi.fn(async () => ({ ok: true as const, page: { years: [], entries: [] } })),
  loadEntry: vi.fn(async () => ({ ok: true as const, sections: [] })),
}));
vi.mock("@/lib/library/mafteiach-fetch", () => loaders);

import { libraryEntryAction, libraryLikkutAction, libraryListAction } from "./actions";

let mem: ReturnType<typeof memoryDb>;
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const likkutPage = { volumes: [{ n: 1, label: "א" }], current: 1, parshiyos: [{ name: "בראשית", entries: [] }] };
const listPage = { years: [{ year: "5711", label: "תשי״א", current: true }], entries: [] };
const entrySections = [{ title: "t", groups: [{ label: "", links: [{ label: "l", url: "https://drive.google.com/file/d/x/view" }] }] }];
const cached = (key: string, kind: string, payload: unknown, expires = inMinutes(60)): Row => ({ key, kind, payload, expires_at: expires });
const onlineFetcher = (): Record<string, Row[]> => ({ library_fetchers: [{ agent_id: "a1" }], agents: [{ id: "a1", status: "active", last_seen_at: minutesAgo(0.5) }] });

function setup(tables: Record<string, Row[]> = {}) {
  mem = memoryDb({ library_pages: [], server_jobs: [], library_fetchers: [], agents: [], ...tables });
  dbBox.client = mem.client;
}
const was = process.env.LIBRARY_VIA_SERVER;
const switchTo = (v: string | undefined) => (v === undefined ? delete process.env.LIBRARY_VIA_SERVER : (process.env.LIBRARY_VIA_SERVER = v));

beforeEach(() => {
  vi.clearAllMocks();
  requireSessionOrRedirect.mockResolvedValue({ userId: "u1", membership: { organization_id: "o1", role: "org_admin", early_tools: false } });
  setup();
});
afterEach(() => switchTo(was));

describe("switch OFF (the default): exactly today's live path", () => {
  for (const value of [undefined, "", "0", "false", "off"]) {
    it(`LIBRARY_VIA_SERVER=${JSON.stringify(value)} fetches live and never touches the cache or the queue`, async () => {
      switchTo(value);
      setup({ ...onlineFetcher(), library_pages: [cached("likkutei:3", "likkutei", likkutPage)] });
      expect(await libraryLikkutAction(3)).toEqual({ ok: true, page: { volumes: [], current: null, parshiyos: [] } });
      expect(loaders.loadLikkutVolume).toHaveBeenCalledWith(3);
      await libraryListAction("maamorim", "5711");
      expect(loaders.loadList).toHaveBeenCalledWith({ section: "maamorim", year: "5711" });
      await libraryEntryAction("/maamorim/1");
      expect(loaders.loadEntry).toHaveBeenCalledWith("/maamorim/1");
      expect(mem.log).toEqual([]); // no table was read or written (only the existing rate-limit rpc ran)
    });
  }
});

describe("switch ON: read-through, then enqueue, or say the print server is offline", () => {
  beforeEach(() => switchTo("1"));

  it("a fresh cached page is returned in the shape the screens expect, without any live fetch or job", async () => {
    setup({
      library_pages: [
        cached("likkutei:3", "likkutei", likkutPage),
        cached("list:maamorim:5711", "list", listPage),
        cached("list:all:current", "list", listPage),
        cached("entry:/maamorim/1", "entry", entrySections),
      ],
    });
    expect(await libraryLikkutAction(3)).toEqual({ ok: true, page: likkutPage });
    expect(await libraryListAction("maamorim", "5711")).toEqual({ ok: true, page: listPage });
    expect(await libraryListAction("all")).toEqual({ ok: true, page: listPage });
    expect(await libraryEntryAction("/maamorim/1")).toEqual({ ok: true, sections: entrySections });
    expect(loaders.loadLikkutVolume).not.toHaveBeenCalled();
    expect(loaders.loadList).not.toHaveBeenCalled();
    expect(loaders.loadEntry).not.toHaveBeenCalled();
    expect(mem.tables.server_jobs).toEqual([]);
  });

  it("an expired page is not served: a job is queued and the answer is a typed 'pending' with the job id", async () => {
    setup({ ...onlineFetcher(), library_pages: [cached("likkutei:3", "likkutei", likkutPage, minutesAgo(1))] });
    const res = await libraryLikkutAction(3);
    expect(res).toMatchObject({ ok: false, pending: true });
    const job = mem.tables.server_jobs[0]!;
    expect((res as { jobId: string }).jobId).toBe(job.id);
    expect(job).toMatchObject({ kind: "library_fetch", organization_id: "o1", requested_by: "u1", status: "queued", dedupe_key: "likkutei:3", params: { kind: "likkutei", volume: 3 } });
    expect(JSON.stringify(job)).not.toMatch(/https?:/);
    expect(loaders.loadLikkutVolume).not.toHaveBeenCalled();
  });

  it("a page nobody has fetched yet: pending for lists and entries too, one shared job per page", async () => {
    setup(onlineFetcher());
    const a = await libraryListAction("maamorim", "5711");
    const b = await libraryListAction("maamorim", "5711");
    const c = await libraryEntryAction("/maamorim/9");
    expect(a).toMatchObject({ ok: false, pending: true });
    expect((b as { jobId: string }).jobId).toBe((a as { jobId: string }).jobId);
    expect(c).toMatchObject({ ok: false, pending: true });
    expect(mem.tables.server_jobs.map((j) => j.dedupe_key)).toEqual(["list:maamorim:5711", "entry:/maamorim/9"]);
  });

  it("no print server online (none registered, or no recent heartbeat): a plain 'offline' answer and no job", async () => {
    for (const tables of [{} as Record<string, Row[]>, { library_fetchers: [{ agent_id: "a1" }], agents: [{ id: "a1", status: "active", last_seen_at: minutesAgo(10) }] }]) {
      setup(tables);
      const res = await libraryEntryAction("/maamorim/9");
      expect(res).toMatchObject({ ok: false, offline: true });
      expect(!res.ok && res.message).toMatch(/print server is not online/i);
      expect(mem.tables.server_jobs).toEqual([]);
    }
  });

  it("a page that failed in the last 5 minutes shows its error instead of queueing again", async () => {
    setup({ ...onlineFetcher(), server_jobs: [{ id: "j0", dedupe_key: "likkutei:3", status: "failed", error: "The library page looks different today.", updated_at: minutesAgo(1) }] });
    const res = await libraryLikkutAction(3);
    expect(res).toEqual({ ok: false, message: "The library page looks different today." });
    expect(mem.tables.server_jobs).toHaveLength(1);
  });

  it("is rate limited per person before it queues anything", async () => {
    setup(onlineFetcher());
    mem.state.rpcAllows = false;
    const res = await libraryEntryAction("/maamorim/9");
    expect(!res.ok && res.message).toMatch(/wait a few minutes/i);
    expect(mem.tables.server_jobs).toEqual([]);
  });

  it("the queue cap answers 'busy'", async () => {
    setup({ ...onlineFetcher(), server_jobs: Array.from({ length: 50 }, (_, i) => ({ id: `q${i}`, dedupe_key: `entry:/maamorim/${i}`, status: "queued" })) });
    const res = await libraryEntryAction("/maamorim/999");
    expect(!res.ok && res.message).toMatch(/busy/i);
    expect(mem.tables.server_jobs).toHaveLength(50);
  });

  it("an address that is not an allowed shape is refused before anything is read or queued", async () => {
    setup(onlineFetcher());
    for (const path of ["https://evil.example/maamorim/1", "/maamorim/1/../x", "/secret"]) {
      const res = await libraryEntryAction(path);
      expect(!res.ok && res.message).toMatch(/not allowed/i);
    }
    expect(mem.tables.server_jobs).toEqual([]);
    expect(mem.log.filter((l) => l.table !== "library_fetchers")).toEqual([]);
  });

  it("a cached row that does not look like the page kind is treated as missing, not served", async () => {
    setup({ ...onlineFetcher(), library_pages: [cached("likkutei:3", "likkutei", "garbage")] });
    expect(await libraryLikkutAction(3)).toMatchObject({ ok: false, pending: true });
  });

  it("the same gate still applies: no organization, or not allowed to use the library", async () => {
    requireSessionOrRedirect.mockResolvedValue({ userId: "u2", membership: null });
    expect((await libraryLikkutAction(1)).ok).toBe(false);
    requireSessionOrRedirect.mockResolvedValue({ userId: "u3", membership: { organization_id: "o1", role: "staff", early_tools: false } });
    const res = await libraryLikkutAction(1);
    expect(!res.ok && res.message).toMatch(/admins first/i);
    expect(mem.log).toEqual([]);
  });

  it("still refuses an unknown section", async () => {
    // @ts-expect-error a client could send anything
    expect((await libraryListAction("secrets")).ok).toBe(false);
    expect(mem.log).toEqual([]);
  });
});
