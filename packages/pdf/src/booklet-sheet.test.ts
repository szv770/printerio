import { describe, expect, it } from "vitest";
import { bookletSheetChoice } from "./booklet-sheet";
import * as build from "./booklet-build";

describe("bookletSheetChoice", () => {
  it("only 'tabloid' selects tabloid, and booklet-build still re-exports it", () => {
    expect(bookletSheetChoice("tabloid")).toBe("tabloid");
    expect(bookletSheetChoice("anything else")).toBe("letter");
    expect(build.bookletSheetChoice).toBe(bookletSheetChoice);
  });
});
