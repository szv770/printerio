import { describe, expect, it } from "vitest";
import { withSizeAliases } from "./paper-sizes";

describe("withSizeAliases", () => {
  it("a profile that says ledger also offers 11x17, keeping ledger", () => {
    expect(withSizeAliases(["letter", "ledger"])).toEqual(["letter", "ledger", "11x17"]);
  });
  it("tabloid too, and any case or spacing", () => {
    expect(withSizeAliases(["letter", " Tabloid "])).toEqual(["letter", " Tabloid ", "11x17"]);
  });
  it("11x17 stays as it is, a Letter-only profile is untouched", () => {
    expect(withSizeAliases(["letter", "11x17"])).toEqual(["letter", "11x17"]);
    expect(withSizeAliases(["letter"])).toEqual(["letter"]);
  });
});
