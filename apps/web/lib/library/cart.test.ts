import { describe, expect, it } from "vitest";
import { addToCart, CART_KEY, CART_MAX, clearCart, MAFTEIACH_CREDIT, readCart, removeFromCart, type CartItem } from "./cart";

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}
const item = (n: number): CartItem => ({ title: `Sicha ${n}`, url: `https://drive.google.com/file/d/id${n}/view`, credit: MAFTEIACH_CREDIT });

describe("library cart", () => {
  it("adds, reads and removes files, keeping the order", () => {
    const s = memory();
    addToCart(item(1), s);
    addToCart(item(2), s);
    expect(readCart(s).map((i) => i.title)).toEqual(["Sicha 1", "Sicha 2"]);
    expect(removeFromCart(item(1).url, s).map((i) => i.title)).toEqual(["Sicha 2"]);
    clearCart(s);
    expect(readCart(s)).toEqual([]);
    expect(s.data.has(CART_KEY)).toBe(false);
  });

  it("never adds the same link twice", () => {
    const s = memory();
    addToCart(item(1), s);
    expect(addToCart(item(1), s).items).toHaveLength(1);
  });

  it("stops at the booklet's limit and says so", () => {
    const s = memory();
    for (let i = 1; i <= CART_MAX; i++) addToCart(item(i), s);
    const over = addToCart(item(99), s);
    expect(over.full).toBe(true);
    expect(over.items).toHaveLength(CART_MAX);
  });

  it("ignores damaged or unsafe stored data", () => {
    const s = memory();
    s.setItem(CART_KEY, "{not json");
    expect(readCart(s)).toEqual([]);
    s.setItem(CART_KEY, JSON.stringify([item(1), { title: "x", url: "http://insecure.example/a", credit: "" }, { title: 5 }, "str"]));
    expect(readCart(s)).toEqual([item(1)]);
  });

  it("keeps an optional page range, and drops a bad one", () => {
    const s = memory();
    addToCart({ ...item(1), pages: "4-18" }, s);
    expect(readCart(s)[0]!.pages).toBe("4-18");
    s.setItem(CART_KEY, JSON.stringify([{ ...item(2), pages: "1-3; drop table" }]));
    expect(readCart(s)[0]!.pages).toBeUndefined();
  });

  it("works without any storage (private windows)", () => {
    expect(readCart(null)).toEqual([]);
    expect(addToCart(item(1), null).items).toEqual([item(1)]);
    expect(() => clearCart(null)).not.toThrow();
  });
});
