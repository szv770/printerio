import { describe, expect, it } from "vitest";
import { prunePrivateRateLimits, pruneHousekeeping, sweepOrphans, ORPHAN_MIN_AGE_MS } from "./cleanup";

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
