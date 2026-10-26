import { describe, expect, it } from "vitest";
import { builderPrintUrl, readBuilderParams, singleFilePrintUrl, readPagesParam } from "./builder-params";

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

describe("one file from the library, with the pages to use", () => {
  it("opens the Print screen with the file and, when given, the page range", () => {
    expect(singleFilePrintUrl()).toBe("/print?built=1");
    expect(singleFilePrintUrl("4-18")).toBe("/print?built=1&pages=4-18");
  });
  it("only ever reads a plain page range back, never anything else", () => {
    expect(readPagesParam("?built=1&pages=4-18")).toBe("4-18");
    expect(readPagesParam("?pages=7")).toBe("7");
    for (const bad of ["?pages=4-18,22", "?pages=abc", "?pages=1-", "?pages=<script>", "?pages=12345-6", ""]) expect(readPagesParam(bad), bad).toBeNull();
  });
});
