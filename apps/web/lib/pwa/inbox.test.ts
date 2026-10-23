import { describe, expect, it } from "vitest";
import { INBOX_MAX_AGE_MS, peekLatestEntry, purgeOldEntries, takeSharedEntry, type InboxEntry, type InboxStore } from "./inbox";

function memoryStore(initial: InboxEntry[] = []): InboxStore & { rows: Map<string, InboxEntry> } {
  const rows = new Map(initial.map((e) => [e.id, e]));
  return {
    rows,
    async get(id) {
      return rows.get(id);
    },
    async delete(id) {
      rows.delete(id);
    },
    async list() {
      return [...rows.values()];
    },
  };
}
const NOW = 1_700_000_000_000;
const entry = (id: string, ageMs: number): InboxEntry => ({ id, name: `${id}.pdf`, size: 4, blob: new Blob(["%PDF"]), at: NOW - ageMs });

describe("takeSharedEntry", () => {
  it("returns the entry and removes it from the inbox", async () => {
    const store = memoryStore([entry("a", 1000)]);
    const r = await takeSharedEntry(store, "a", NOW);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.entry.name).toBe("a.pdf");
    expect(store.rows.size).toBe(0);
  });
  it("says missing for an id that is not there", async () => {
    expect((await takeSharedEntry(memoryStore(), "nope", NOW)).status).toBe("missing");
  });
  it("treats an entry older than an hour as expired, and removes it", async () => {
    const store = memoryStore([entry("old", INBOX_MAX_AGE_MS + 1)]);
    expect((await takeSharedEntry(store, "old", NOW)).status).toBe("missing");
    expect(store.rows.size).toBe(0);
  });
  it("says unavailable when the store throws", async () => {
    const store: InboxStore = {
      get: async () => {
        throw new Error("IndexedDB is blocked");
      },
      delete: async () => {},
      list: async () => [],
    };
    expect((await takeSharedEntry(store, "a", NOW)).status).toBe("unavailable");
  });
  it("says unavailable when there is no store at all", async () => {
    expect((await takeSharedEntry(null, "a", NOW)).status).toBe("unavailable");
  });
});

describe("purgeOldEntries", () => {
  it("removes only entries older than the max age", async () => {
    const store = memoryStore([entry("fresh", 60_000), entry("edge", INBOX_MAX_AGE_MS), entry("stale", INBOX_MAX_AGE_MS + 1), entry("ancient", 99 * INBOX_MAX_AGE_MS)]);
    const removed = await purgeOldEntries(store, NOW);
    expect(removed).toBe(2);
    expect([...store.rows.keys()].sort()).toEqual(["edge", "fresh"]);
  });
  it("never throws, even when the store does", async () => {
    const store: InboxStore = {
      get: async () => undefined,
      delete: async () => {},
      list: async () => {
        throw new Error("nope");
      },
    };
    await expect(purgeOldEntries(store, NOW)).resolves.toBe(0);
    await expect(purgeOldEntries(null, NOW)).resolves.toBe(0);
  });
});

describe("peekLatestEntry", () => {
  it("returns the newest fresh entry without removing it", async () => {
    const store = memoryStore([entry("a", 5000), entry("b", 1000), entry("c", INBOX_MAX_AGE_MS + 1)]);
    expect(await peekLatestEntry(store, NOW)).toEqual({ id: "b", name: "b.pdf" });
    expect(store.rows.size).toBe(3);
  });
  it("returns null when nothing is waiting, the only entry is stale, or the store fails", async () => {
    expect(await peekLatestEntry(memoryStore(), NOW)).toBeNull();
    expect(await peekLatestEntry(memoryStore([entry("old", INBOX_MAX_AGE_MS + 1)]), NOW)).toBeNull();
    expect(await peekLatestEntry(null, NOW)).toBeNull();
    const broken: InboxStore = {
      get: async () => undefined,
      delete: async () => {},
      list: async () => {
        throw new Error("x");
      },
    };
    expect(await peekLatestEntry(broken, NOW)).toBeNull();
  });
});
