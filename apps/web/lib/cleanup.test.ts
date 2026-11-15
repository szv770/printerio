import { describe, expect, it } from "vitest";
import { prunePrivateRateLimits, pruneHousekeeping, pruneLibraryData, sweepOrphans, ORPHAN_MIN_AGE_MS } from "./cleanup";
import { memoryDb, type Row } from "@/test/memory-db";

const NOW = new Date("2026-10-25T03:00:00Z");
const old = new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS - 60_000).toISOString();
const young = new Date(NOW.getTime() - 60 * 60_000).toISOString();

interface Entry {
  name: string;
  id: string | null;
  created_at?: string;
}
const folder = (name: string): Entry => ({ name, id: null });
const file = (name: string, created_at: string): Entry => ({ name, id: `id-${name}`, created_at });

/** A tiny storage + table fake: `tree` maps a folder path to its entries. */
function fake(tree: Record<string, Entry[]>, liveJobIds: string[] = [], staleCommands: string[] = []) {
  const removed: string[] = [];
  const deletedCommandIds: string[] = [];
  const client = {
    storage: {
      from: () => ({
        list: async (path: string, opts?: { limit?: number; offset?: number }) => {
          const all = tree[path] ?? [];
          const offset = opts?.offset ?? 0;
          return { data: all.slice(offset, offset + (opts?.limit ?? 100)), error: null };
        },
        remove: async (paths: string[]) => {
          removed.push(...paths);
          return { data: [], error: null };
        },
      }),
    },
    from: (table: string) => {
      const q: { ids?: string[]; limit?: number; isDelete?: boolean } = {};
      const chain: Record<string, unknown> = {
        select: () => chain,
        in: (_col: string, ids: string[]) => {
          if (table === "remote_commands" && q.isDelete && _col === "id") deletedCommandIds.push(...ids);
          q.ids = ids;
          return chain;
        },
        lt: () => chain,
        order: () => chain,
        limit: (n: number) => ((q.limit = n), chain),
        delete: () => ((q.isDelete = true), chain),
        then: (resolve: (v: unknown) => void) => {
          if (table === "print_jobs") {
            return resolve({ data: (q.ids ?? []).filter((i) => liveJobIds.includes(i)).map((id) => ({ id })), error: null });
          }
          if (table === "remote_commands" && !q.isDelete) {
            return resolve({ data: staleCommands.slice(0, q.limit ?? 1000).map((id) => ({ id })), error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
  return { client: client as never, removed, deletedCommandIds };
}

describe("sweepOrphans - gateway intake", () => {
  const tree = {
    "gateway-intake": [folder("dev1")],
    "gateway-intake/dev1": [file("old.pdf", old), file("young.pdf", young)],
  };

  it("deletes intake objects older than 24h and leaves young ones alone", async () => {
    const f = fake(tree);
    const r = await sweepOrphans(f.client, { now: NOW });
    expect(f.removed).toEqual(["gateway-intake/dev1/old.pdf"]);
    expect(r.intakeDeleted).toBe(1);
  });

  it("is idempotent when nothing is left to delete", async () => {
    const f = fake({ "gateway-intake": [folder("dev1")], "gateway-intake/dev1": [file("young.pdf", young)] });
    const r = await sweepOrphans(f.client, { now: NOW });
    expect(f.removed).toEqual([]);
    expect(r.intakeDeleted).toBe(0);
  });

  it("respects the per-run delete cap", async () => {
    const many = Array.from({ length: 10 }, (_, i) => file(`o${i}.pdf`, old));
    const f = fake({ "gateway-intake": [folder("dev1")], "gateway-intake/dev1": many });
    const r = await sweepOrphans(f.client, { now: NOW, maxDeletes: 3 });
    expect(f.removed).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });
});

describe("sweepOrphans - job files without a job row", () => {
  const ORG = "org1";
  const tree = {
    "gateway-intake": [],
    org: [folder(ORG)],
    [`org/${ORG}/jobs`]: [folder("live"), folder("gone"), folder("fresh")],
    [`org/${ORG}/jobs/live`]: [file("original.pdf", old)],
    [`org/${ORG}/jobs/gone`]: [file("original.pdf", old), file("derived.pdf", old)],
    [`org/${ORG}/jobs/fresh`]: [file("original.pdf", young)],
  };

  it("removes files of a job whose row is gone, keeps live jobs and young files", async () => {
    const f = fake(tree, ["live"]);
    const r = await sweepOrphans(f.client, { now: NOW });
    expect(f.removed.sort()).toEqual([`org/${ORG}/jobs/gone/derived.pdf`, `org/${ORG}/jobs/gone/original.pdf`]);
    expect(r.jobOrphansDeleted).toBe(2);
    expect(r.orphanPaths).toContain(`org/${ORG}/jobs/gone/original.pdf`);
  });

  it("never deletes a young file even if its row does not exist yet (upload happens before insert)", async () => {
    const f = fake(tree, []);
    await sweepOrphans(f.client, { now: NOW });
    expect(f.removed.some((p) => p.includes("/fresh/"))).toBe(false);
  });
});

describe("pruneHousekeeping", () => {
  it("deletes stale finished remote commands in a capped batch", async () => {
    const f = fake({}, [], ["c1", "c2", "c3"]);
    const r = await pruneHousekeeping(f.client, { now: NOW, limit: 2 });
    expect(f.deletedCommandIds).toEqual(["c1", "c2"]);
    expect(r.remoteCommandsDeleted).toBe(2);
  });
});

describe("prunePrivateRateLimits", () => {
  it("calls prune_rate_limit_buckets for windows older than a day and returns the count", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = { rpc: async (name: string, args: unknown) => (calls.push([name, args]), { data: 7, error: null }) } as never;
    expect(await prunePrivateRateLimits(client)).toBe(7);
    expect(calls).toEqual([["prune_rate_limit_buckets", { p_older_than: "1 day" }]]);
  });

  it("never throws: an RPC error (migration not applied yet) is reported as 0", async () => {
    const client = { rpc: async () => ({ data: null, error: { message: "function does not exist" } }) } as never;
    expect(await prunePrivateRateLimits(client)).toBe(0);
  });
});

describe("pruneLibraryData (the library's shared cache, daily text and finished jobs)", () => {
  const day = 86_400_000;
  const ago = (days: number) => new Date(NOW.getTime() - days * day).toISOString();
  const dateAgo = (days: number) => ago(days).slice(0, 10);
  const page = (key: string, expiredDaysAgo: number): Row => ({ key, kind: "entry", payload: [], expires_at: ago(expiredDaysAgo) });
  const text = (study: string, daysOld: number): Row => ({ study, study_date: dateAgo(daysOld), portion: "p", sections: [] });
  const jobRow = (id: string, status: string, daysOld: number): Row => ({ id, kind: "library_fetch", status, dedupe_key: id, updated_at: ago(daysOld), created_at: ago(daysOld) });

  const seed = () =>
    memoryDb({
      library_pages: [page("expired-31d", 31), page("expired-29d", 29), page("expired-1d", 1), page("fresh", -3)],
      library_daily_texts: [text("tanya", 61), text("chumash", 61), text("tanya", 59), text("tanya", 1), text("rambam1", -3)],
      server_jobs: [
        jobRow("done-8d", "done", 8),
        jobRow("failed-8d", "failed", 8),
        jobRow("done-6d", "done", 6),
        jobRow("failed-1d", "failed", 1),
        jobRow("queued-8d", "queued", 8),
        jobRow("claimed-8d", "claimed", 8),
      ],
    });

  it("removes only pages expired more than 30 days ago", async () => {
    const mem = seed();
    const r = await pruneLibraryData(mem.client as never, { now: NOW });
    expect(mem.tables.library_pages!.map((p) => p.key).sort()).toEqual(["expired-1d", "expired-29d", "fresh"]);
    expect(r.libraryPagesDeleted).toBe(1);
  });

  it("removes only daily text whose study date is more than 60 days ago (every study of that day)", async () => {
    const mem = seed();
    const r = await pruneLibraryData(mem.client as never, { now: NOW });
    expect(mem.tables.library_daily_texts!.map((t) => `${t.study}@${t.study_date}`).sort()).toEqual(
      [`tanya@${dateAgo(59)}`, `tanya@${dateAgo(1)}`, `rambam1@${dateAgo(-3)}`].sort(),
    );
    expect(r.libraryDailyTextsDeleted).toBe(2);
  });

  it("removes only finished or failed jobs older than 7 days; a queued or claimed job is never touched, however old", async () => {
    const mem = seed();
    const r = await pruneLibraryData(mem.client as never, { now: NOW });
    expect(mem.tables.server_jobs!.map((j) => j.id).sort()).toEqual(["claimed-8d", "done-6d", "failed-1d", "queued-8d"]);
    expect(r.serverJobsDeleted).toBe(2);
  });

  it("is idempotent, and does nothing to empty tables", async () => {
    const mem = seed();
    await pruneLibraryData(mem.client as never, { now: NOW });
    const again = await pruneLibraryData(mem.client as never, { now: NOW });
    expect(again).toEqual({ libraryPagesDeleted: 0, libraryDailyTextsDeleted: 0, serverJobsDeleted: 0 });
    const empty = await pruneLibraryData(memoryDb().client as never, { now: NOW });
    expect(empty).toEqual({ libraryPagesDeleted: 0, libraryDailyTextsDeleted: 0, serverJobsDeleted: 0 });
  });

  it("respects the per-run cap (the rest goes on the next run)", async () => {
    const mem = memoryDb({
      library_pages: Array.from({ length: 5 }, (_, i) => page(`old-${i}`, 40 + i)),
      library_daily_texts: [],
      server_jobs: Array.from({ length: 5 }, (_, i) => jobRow(`j${i}`, "done", 10 + i)),
    });
    const r = await pruneLibraryData(mem.client as never, { now: NOW, limit: 2 });
    expect(r.libraryPagesDeleted).toBe(2);
    expect(r.serverJobsDeleted).toBe(2);
    expect(mem.tables.library_pages).toHaveLength(3);
    expect(mem.tables.server_jobs).toHaveLength(3);
  });

  it("a failing table does not stop the others and nothing throws", async () => {
    const mem = seed();
    const realFrom = mem.client.from;
    const client = { from: (t: string) => (t === "library_pages" ? { select: () => { throw new Error("boom"); } } : realFrom(t)) };
    const r = await pruneLibraryData(client as never, { now: NOW });
    expect(r.libraryPagesDeleted).toBe(0);
    expect(r.libraryDailyTextsDeleted).toBe(2);
    expect(r.serverJobsDeleted).toBe(2);
  });

  it("pruneHousekeeping includes it (the daily cleanup route calls pruneHousekeeping)", async () => {
    const mem = seed();
    const r = await pruneHousekeeping(mem.client as never, { now: NOW });
    expect(r).toMatchObject({ remoteCommandsDeleted: 0, libraryPagesDeleted: 1, libraryDailyTextsDeleted: 2, serverJobsDeleted: 2 });
  });
});
