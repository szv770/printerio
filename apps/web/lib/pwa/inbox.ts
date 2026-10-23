/**
 * The share inbox: a shared PDF waits in IndexedDB (database "printio-share", object store "inbox") between the
 * service worker, which receives it, and the Print page, which picks it up. The logic here talks to a small
 * injectable `InboxStore`, so it is unit-tested without a browser; `createIndexedDbStore` is the real one.
 */

export const INBOX_DB_NAME = "printio-share";
export const INBOX_STORE_NAME = "inbox";
/** Entries older than this are thrown away: a forgotten share must not sit on a shared school device for days. */
export const INBOX_MAX_AGE_MS = 60 * 60 * 1000;

export interface InboxEntry {
  id: string;
  name: string;
  size: number;
  blob: Blob;
  /** Epoch ms when it arrived. */
  at: number;
}

export interface InboxStore {
  get(id: string): Promise<InboxEntry | undefined>;
  delete(id: string): Promise<void>;
  list(): Promise<InboxEntry[]>;
}

export type TakeResult =
  | { status: "ok"; entry: InboxEntry }
  | { status: "missing" }
  | { status: "unavailable" };

/** Reads an entry and removes it. An expired entry is removed and reported as missing. */
export async function takeSharedEntry(store: InboxStore | null, id: string, now: number): Promise<TakeResult> {
  if (!store) return { status: "unavailable" };
  try {
    const entry = await store.get(id);
    if (!entry) return { status: "missing" };
    if (now - entry.at > INBOX_MAX_AGE_MS) {
      await store.delete(id);
      return { status: "missing" };
    }
    await store.delete(id);
    return { status: "ok", entry };
  } catch {
    return { status: "unavailable" };
  }
}

/** Deletes entries older than the max age. Returns how many were removed. Never throws. */
export async function purgeOldEntries(store: InboxStore | null, now: number): Promise<number> {
  if (!store) return 0;
  let removed = 0;
  try {
    for (const entry of await store.list()) {
      if (now - entry.at > INBOX_MAX_AGE_MS) {
        await store.delete(entry.id);
        removed += 1;
      }
    }
  } catch {
    // Best effort.
  }
  return removed;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** The real store, or null when IndexedDB does not exist here (private modes, old browsers). */
export function createIndexedDbStore(): InboxStore | null {
  if (typeof indexedDB === "undefined") return null;
  let dbPromise: Promise<IDBDatabase> | null = null;
  const open = () => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(INBOX_DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(INBOX_STORE_NAME)) {
          req.result.createObjectStore(INBOX_STORE_NAME, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Could not open the share inbox"));
      req.onblocked = () => reject(new Error("The share inbox is blocked"));
    });
    return dbPromise;
  };
  const store = async (mode: IDBTransactionMode) => (await open()).transaction(INBOX_STORE_NAME, mode).objectStore(INBOX_STORE_NAME);
  return {
    async get(id) {
      return (await request((await store("readonly")).get(id))) as InboxEntry | undefined;
    },
    async delete(id) {
      await request((await store("readwrite")).delete(id));
    },
    async list() {
      return (await request((await store("readonly")).getAll())) as InboxEntry[];
    },
  };
}
