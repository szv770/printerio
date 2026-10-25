import { describe, expect, it } from "vitest";
import { bookletBlankPagesNote } from "./booklet-note";

describe("bookletBlankPagesNote", () => {
  it("says how many blank pages are added and what the booklet comes to", () => {
    expect(bookletBlankPagesNote(5)).toBe("Adding 3 blank pages at the end to fill the booklet (5 → 8 pages).");
    expect(bookletBlankPagesNote(7)).toBe("Adding 1 blank page at the end to fill the booklet (7 → 8 pages).");
    expect(bookletBlankPagesNote(10)).toBe("Adding 2 blank pages at the end to fill the booklet (10 → 12 pages).");
  });
  it("is silent when the page count already fits, or is not known", () => {
    expect(bookletBlankPagesNote(8)).toBeNull();
    expect(bookletBlankPagesNote(null)).toBeNull();
    expect(bookletBlankPagesNote(0)).toBeNull();
  });
});
