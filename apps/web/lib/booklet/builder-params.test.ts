import { describe, expect, it } from "vitest";
import { builderPrintUrl, readBuilderParams } from "./builder-params";

describe("builder -> print screen choices", () => {
  it("Hebrew (right to left) binds on the right; English binds on the left; the size travels with it", () => {
    expect(builderPrintUrl("rtl", "letter")).toBe("/print?built=1&booklet=right&sheet=letter");
    expect(builderPrintUrl("ltr", "tabloid")).toBe("/print?built=1&booklet=left&sheet=tabloid");
  });

  it("reads them back, and ignores anything else", () => {
    expect(readBuilderParams("?built=1&booklet=right&sheet=tabloid")).toEqual({ booklet: "right", sheet: "tabloid" });
    expect(readBuilderParams("?booklet=left")).toEqual({ booklet: "left", sheet: null });
    expect(readBuilderParams("?booklet=sideways&sheet=huge")).toEqual({ booklet: null, sheet: null });
    expect(readBuilderParams("")).toEqual({ booklet: null, sheet: null });
  });

  it("a round trip keeps the choices", () => {
    for (const dir of ["ltr", "rtl"] as const) {
      for (const sheet of ["letter", "tabloid"] as const) {
        const url = builderPrintUrl(dir, sheet);
        expect(readBuilderParams(url.slice(url.indexOf("?")))).toEqual({ booklet: dir === "rtl" ? "right" : "left", sheet });
      }
    }
  });
});
