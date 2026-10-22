import { describe, expect, it } from "vitest";
import { decodeIpp, encodeIpp, flatten, TAG } from "../src/ipp/codec.js";
import { buildPrinterAttributes, DOCUMENT_FORMATS, filterRequested } from "../src/ipp/printer-attributes.js";

const build = () =>
  buildPrinterAttributes({ baseUrl: "https://u-x.example.test", printerName: "Printio", uuidSeed: "seed", startedAt: Date.now() });

describe("printer attributes", () => {
  it("lists PDF first, keeps the spike's format list, monochrome, Letter default, finishings none only", () => {
    const m = decodeIpp(encodeIpp({ code: 0, requestId: 1, groups: [{ tag: TAG.printer, attrs: build() }] }));
    const p = flatten(m.groups[0]);
    expect(p["document-format-supported"]).toEqual(DOCUMENT_FORMATS);
    expect((p["document-format-supported"] as string[])[0]).toBe("application/pdf");
    expect(p["document-format-default"]).toBe("application/pdf");
    expect(p["print-color-mode-supported"]).toBe("monochrome");
    expect(p["print-color-mode-default"]).toBe("monochrome");
    expect(p["media-default"]).toBe("na_letter_8.5x11in");
    expect(p["media-col-default"]).toEqual({ "media-size": { "x-dimension": 21590, "y-dimension": 27940 } });
    expect(p["finishings-supported"]).toBe(3);
    expect(p["finishings-default"]).toBe(3);
    expect(p["copies-supported"]).toEqual([1, 99]);
    expect(p["sides-supported"]).toEqual(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]);
    expect(p["printer-uri-supported"]).toBe("https://u-x.example.test/ipp/print");
    expect(p["uri-security-supported"]).toBe("tls");
    expect(p["printer-name"]).toBe("Printio");
    expect(p["page-ranges-supported"]).toBe(true);
  });

  it("uses the same operations the handlers implement", () => {
    const p = flatten({ tag: TAG.printer, attrs: build() });
    expect(p["operations-supported"]).toEqual([2, 4, 5, 6, 8, 9, 10, 11]);
  });

  it("honours requested-attributes", () => {
    const names = (r: string | string[] | undefined) => filterRequested(build(), r).map((a) => a.name);
    expect(names(["printer-name", "finishings-supported"])).toEqual(["printer-name", "finishings-supported"]);
    expect(names("printer-name")).toEqual(["printer-name"]);
    expect(names(["all"]).length).toBe(build().length);
    expect(names(["printer-description"]).length).toBe(build().length);
    expect(names(undefined).length).toBe(build().length);
    expect(names(["no-such-attribute"])).toEqual([]);
  });
});
