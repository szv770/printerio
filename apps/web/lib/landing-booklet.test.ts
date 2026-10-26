import { describe, expect, it } from "vitest";
import { BOOKLET_PAGES, bookletSpread, spreadCaption, SPREAD_COUNT } from "./landing-booklet";

describe("the home page booklet", () => {
  it("opens like a real book: the cover is on the right, then pages come in pairs, then the back page is on the left", () => {
    expect(bookletSpread(0)).toEqual({ left: null, right: 1 });
    expect(bookletSpread(1)).toEqual({ left: 2, right: 3 });
    expect(bookletSpread(2)).toEqual({ left: 4, right: 5 });
    expect(bookletSpread(3)).toEqual({ left: 6, right: 7 });
    expect(bookletSpread(SPREAD_COUNT - 1)).toEqual({ left: 8, right: null });
  });

  it("shows every page exactly once, in reading order, as you flip through", () => {
    const seen: number[] = [];
    for (let i = 0; i < SPREAD_COUNT; i++) {
      const s = bookletSpread(i);
      // left page comes before the right page of the same spread, and the previous spread's right page comes before this left page
      if (s.left !== null) seen.push(s.left);
      if (s.right !== null) seen.push(s.right);
    }
    expect(seen).toEqual(Array.from({ length: BOOKLET_PAGES }, (_, i) => i + 1));
  });

  it("when a page turns, its back is the next spread's left page (so no page is ever skipped or shown twice)", () => {
    for (let i = 0; i < SPREAD_COUNT - 1; i++) {
      const here = bookletSpread(i);
      const next = bookletSpread(i + 1);
      const front = here.right;
      const back = next.left;
      expect(front).not.toBeNull();
      expect(back).not.toBeNull();
      expect(back).toBe(front! + 1);
    }
  });

  it("refuses a spread that does not exist and describes each one in plain words", () => {
    expect(() => bookletSpread(-1)).toThrow();
    expect(() => bookletSpread(SPREAD_COUNT)).toThrow();
    expect(spreadCaption(0)).toBe("The cover, page 1");
    expect(spreadCaption(2)).toBe("Pages 4 and 5");
    expect(spreadCaption(SPREAD_COUNT - 1)).toBe("The back, page 8");
  });
});
