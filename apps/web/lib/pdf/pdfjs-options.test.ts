import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pdfjsAssetOptions } from "./pdfjs-options";

describe("pdfjsAssetOptions", () => {
  it("points at the copied assets, each URL ending in a slash (pdf.js appends file names)", () => {
    const o = pdfjsAssetOptions();
    expect(o).toEqual({ wasmUrl: "/pdfjs/wasm/", iccUrl: "/pdfjs/iccs/", standardFontDataUrl: "/pdfjs/standard_fonts/" });
  });

  it("the installed pdfjs-dist really has every file the copy script needs", () => {
    const pkg = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
    for (const f of ["jbig2.wasm", "jbig2_nowasm_fallback.js", "openjpeg.wasm", "openjpeg_nowasm_fallback.js", "qcms_bg.wasm"]) {
      expect(existsSync(path.join(pkg, "wasm", f)), f).toBe(true);
    }
    expect(existsSync(path.join(pkg, "iccs"))).toBe(true);
    expect(existsSync(path.join(pkg, "standard_fonts"))).toBe(true);
  });
});
