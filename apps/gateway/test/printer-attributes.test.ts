import { describe, expect, it } from "vitest";
import { decodeIpp, encodeIpp, flatten, TAG } from "../src/ipp/codec.js";
import { buildPrinterAttributes, DOCUMENT_FORMATS, filterRequested } from "../src/ipp/printer-attributes.js";

const build = () =>
  buildPrinterAttributes({ baseUrl: "https://u-x.example.test", printerName: "Printio", uuidSeed: "seed", startedAt: Date.now() });

describe("printer attributes", () => {
  it("lists PDF first, keeps the spike's format list, monochrome, Letter default, default no finishing", () => {
    const m = decodeIpp(encodeIpp({ code: 0, requestId: 1, groups: [{ tag: TAG.printer, attrs: build() }] }));
    const p = flatten(m.groups[0]);
    expect(p["document-format-supported"]).toEqual(DOCUMENT_FORMATS);
    expect((p["document-format-supported"] as string[])[0]).toBe("application/pdf");
    expect(p["document-format-default"]).toBe("application/pdf");
    expect(p["print-color-mode-supported"]).toBe("monochrome");
    expect(p["print-color-mode-default"]).toBe("monochrome");
    expect(p["media-default"]).toBe("na_letter_8.5x11in");
    expect(p["media-col-default"]).toEqual({ "media-size": { "x-dimension": 21590, "y-dimension": 27940 } });
    expect(p["finishings-default"]).toBe(3);
    expect(p["copies-supported"]).toEqual([1, 99]);
    expect(p["sides-supported"]).toEqual(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]);
    expect(p["printer-uri-supported"]).toBe("https://u-x.example.test/ipp/print");
    expect(p["uri-security-supported"]).toBe("tls");
    expect(p["printer-name"]).toBe("Printio");
    expect(p["page-ranges-supported"]).toBe(true);
  });

  it("advertises exactly the finishings the website can deliver: none, staple, top-left, top-right, saddle-stitch, booklet-maker", () => {
    const p = flatten({ tag: TAG.printer, attrs: build() });
    expect(p["finishings-supported"]).toEqual([3, 4, 20, 22, 8, 13]);
    // Never advertise what cannot be delivered (bottom-left 21, dual staples 28-31, punch 5/70+, fold 10).
    for (const v of [5, 10, 21, 23, 28, 29, 30, 31, 70]) expect(p["finishings-supported"]).not.toContain(v);
  });

  it("keeps the sides and orientation options the dialog needs", () => {
    const p = flatten({ tag: TAG.printer, attrs: build() });
    expect(p["sides-supported"]).toEqual(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]);
    expect(p["orientation-requested-supported"]).toEqual([3, 4, 5, 6]);
    expect(p["job-creation-attributes-supported"]).toContain("finishings");
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

describe("advertised finishings", () => {
  const finishingsOf = (finishings?: readonly number[]) => {
    const attrs = buildPrinterAttributes({
      baseUrl: "https://u-x.example.test",
      printerName: "Printio",
      uuidSeed: "seed",
      startedAt: Date.now(),
      finishings,
    });
    const m = decodeIpp(encodeIpp({ code: 0, requestId: 1, groups: [{ tag: TAG.printer, attrs }] }));
    return flatten(m.groups[0])["finishings-supported"];
  };

  it("advertises the full list by default", () => {
    expect(finishingsOf()).toEqual([3, 4, 20, 22, 8, 13]);
  });
  it("can advertise 'none' only, exactly what the spike sent when Windows 11 accepted the printer", () => {
    expect(finishingsOf([3])).toBe(3);
  });
});

describe("AirPrint extras (only for iPhone/Mac devices)", () => {
  const p = (airprint?: boolean) => {
    const attrs = buildPrinterAttributes({ baseUrl: "https://u-x.example.test", printerName: "Printio", uuidSeed: "seed", startedAt: Date.now(), airprint });
    return flatten(decodeIpp(encodeIpp({ code: 0, requestId: 1, groups: [{ tag: TAG.printer, attrs }] })).groups[0]);
  };
  it("adds image/urf and urf-supported when asked, keeping PDF first", () => {
    const withAp = p(true);
    expect((withAp["document-format-supported"] as string[])[0]).toBe("application/pdf");
    expect(withAp["document-format-supported"]).toContain("image/urf");
    expect(withAp["urf-supported"]).toBeDefined();
  });
  it("leaves Windows/Android attributes exactly as they were", () => {
    const without = p(false);
    expect(without["document-format-supported"]).toEqual(DOCUMENT_FORMATS);
    expect(without["urf-supported"]).toBeUndefined();
    expect(p()["document-format-supported"]).toEqual(DOCUMENT_FORMATS);
  });
});
