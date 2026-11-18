/**
 * The files picked in the library browser, waiting to be added to the booklet builder. Kept in the tab's sessionStorage
 * (gone when the tab closes), holding only what is public: each file's title and its Drive link, never any file.
 */

export interface CartItem {
  /** Shown as the file's name in the builder (the person can rename it there). */
  title: string;
  /** The Google Drive or Docs link; the builder fetches it through the normal safe link import. */
  url: string;
  /** "Mafteiach (mafteiach.app)": printed as "Courtesy of ..." on the contents page. */
  credit: string;
  /** Pages to use, like "4-18" (SIE files open with a cover and dedication pages that are skipped). Absent = every page. */
  pages?: string;
}

export const CART_KEY = "printio-library-cart";
/** Same as the builder's limit on files per booklet. */
export const CART_MAX = 12;
export const MAFTEIACH_CREDIT = "Mafteiach (mafteiach.app)";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const PAGES = /^\d{1,4}(-\d{1,4})?$/;

const isItem = (v: unknown): v is CartItem =>
  typeof v === "object" && v !== null && typeof (v as CartItem).title === "string" && typeof (v as CartItem).url === "string" && typeof (v as CartItem).credit === "string" && /^https:\/\//.test((v as CartItem).url);

/** A stored item with only safe, known fields (a damaged or tampered page range is dropped). */
const clean = (v: CartItem): CartItem => ({ title: v.title, url: v.url, credit: v.credit, ...(typeof v.pages === "string" && PAGES.test(v.pages) ? { pages: v.pages } : {}) });

export function readCart(storage: StorageLike | null = defaultStorage()): CartItem[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CART_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isItem).map(clean).slice(0, CART_MAX) : [];
  } catch {
    return [];
  }
}

function write(items: CartItem[], storage: StorageLike | null): void {
  if (!storage) return;
  try {
    if (items.length === 0) storage.removeItem(CART_KEY);
    else storage.setItem(CART_KEY, JSON.stringify(items));
  } catch {
    /* storage full or blocked: the picks just do not survive a reload */
  }
}

/** Adds a file. The same link is never added twice. Returns the new cart, and `full` when the limit stopped it. */
export function addToCart(item: CartItem, storage: StorageLike | null = defaultStorage()): { items: CartItem[]; full: boolean } {
  const items = readCart(storage);
  if (items.some((i) => i.url === item.url)) return { items, full: false };
  if (items.length >= CART_MAX) return { items, full: true };
  const next = [...items, item];
  write(next, storage);
  return { items: next, full: false };
}

export function removeFromCart(url: string, storage: StorageLike | null = defaultStorage()): CartItem[] {
  const next = readCart(storage).filter((i) => i.url !== url);
  write(next, storage);
  return next;
}

export function clearCart(storage: StorageLike | null = defaultStorage()): void {
  write([], storage);
}
