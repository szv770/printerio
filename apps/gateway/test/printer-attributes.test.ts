import { describe, expect, it } from "vitest";
import { decodeIpp, encodeIpp, flatten, TAG } from "../src/ipp/codec.js";
import { presetMediaTypeNames } from "@printio/shared";
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
    expect(p["media-col-default"]).toEqual({ "media-size": { "x-dimension": 21590, "y-dimension": 27940 }, "media-type": "stationery" });
    expect(p["finishings-default"]).toBe(3);
    expect(p["copies-supported"]).toEqual([1, 99]);
    expect(p["sides-supported"]).toEqual(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]);
    expect(p["printer-uri-supported"]).toBe("https://u-x.example.test/ipp/print");
    expect(p["uri-security-supported"]).toBe("tls");
    expect(p["printer-name"]).toBe("Printio");
    expect(p["page-ranges-supported"]).toBe(true);
  });

  it("advertises exactly the finishings the website can deliver: none, staple, top-left, top-right, saddle-stitch, booklet-maker, punch, dual-left", () => {
    const p = flatten({ tag: TAG.printer, attrs: build() });
    expect(p["finishings-supported"]).toEqual([3, 4, 20, 22, 8, 13, 5, 28]);
    // Never advertise what cannot be delivered (bottom-left 21, dual staples 28-31, punch 5/70+, fold 10).
    for (const v of [10, 21, 23, 29, 30, 31, 70, 78]) expect(p["finishings-supported"]).not.toContain(v);
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

describe("advertised paper sizes", () => {
  const p = () => flatten({ tag: TAG.printer, attrs: build() });
  it("offers Letter (default) and Ledger 11x17 only: no A4/A3 or other sizes", () => {
    expect(p()["media-supported"]).toEqual(["na_letter_8.5x11in", "na_ledger_11x17in"]);
    expect(p()["media-ready"]).toEqual(["na_letter_8.5x11in", "na_ledger_11x17in"]);
    expect(p()["media-default"]).toBe("na_letter_8.5x11in");
    const letter = { "x-dimension": 21590, "y-dimension": 27940 };
    const ledger = { "x-dimension": 27940, "y-dimension": 43180 };
    const types = p()["media-type-supported"] as string[];
    const combos = [letter, ledger].flatMap((size) => types.map((t) => ({ "media-size": size, "media-type": t })));
    expect(p()["media-col-database"]).toEqual(combos);
    expect(p()["media-col-ready"]).toEqual(combos);
  });
});

describe("advertised paper types (presets)", () => {
  const p = () => flatten({ tag: TAG.printer, attrs: build() });
  it("lists stationery first, then every preset name", () => {
    expect(p()["media-type-supported"]).toEqual(["stationery", ...presetMediaTypeNames()]);
    expect((p()["media-type-supported"] as string[])[1]).toBe("Booklet - right edge, stapled");
  });
  it("offers every size with every type and puts media-size before media-type", () => {
    const db = p()["media-col-database"] as Array<Record<string, unknown>>;
    expect(db).toHaveLength(2 * presetMediaTypeNames().length + 2);
    expect(Object.keys(db[0] as object)).toEqual(["media-size", "media-type"]);
    expect(p()["media-col-supported"]).toEqual(["media-size", "media-type"]);
  });
  it("leaves every other attribute as before", () => {
    const m = decodeIpp(encodeIpp({ code: 0, requestId: 1, groups: [{ tag: TAG.printer, attrs: build() }] }));
    const names = m.groups[0]!.attrs.map((a) => a.name);
    expect(names.filter((n) => n === "media-type-supported")).toHaveLength(1);
    expect(p()["media-supported"]).toEqual(["na_letter_8.5x11in", "na_ledger_11x17in"]);
    expect(p()["finishings-supported"]).toEqual([3, 4, 20, 22, 8, 13, 5, 28]);
    expect(p()["sides-supported"]).toEqual(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]);
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
    expect(finishingsOf()).toEqual([3, 4, 20, 22, 8, 13, 5, 28]);
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

describe("printer name and description follow the device's label (every device type)", () => {
  it("printer-info (the description many clients show) carries the same Printio-<printer>-<code> label", () => {
    const attrs = buildPrinterAttributes({ baseUrl: "https://u-x.example.test", printerName: "Printio-MLMI-SZV", uuidSeed: "s", startedAt: Date.now() });
    const p = flatten(decodeIpp(encodeIpp({ code: 0, requestId: 1, groups: [{ tag: TAG.printer, attrs }] })).groups[0]);
    expect(p["printer-name"]).toBe("Printio-MLMI-SZV");
    expect(p["printer-info"]).toBe("Printio-MLMI-SZV");
  });
});
