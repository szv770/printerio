import { describe, expect, it } from "vitest";
import { mapRawChoices, parseChoices, type PrintChoices } from "./print-choices";
import { liveSummaryLine, summarizeColor } from "./print-form-summary";

const form = (fields: Record<string, string>) => (name: string) => (name in fields ? fields[name]! : null);

describe("the form contract: paperType and the flip edge", () => {
  it("paperType=cardstock is read; plain, missing or junk is plain (older forms never sent it)", () => {
    const ok = (f: Record<string, string>) => {
      const r = parseChoices(form({ sides: "one", copies: "1", ...f }));
      if (!r.ok) throw new Error(r.reason);
      return r.choices;
    };
    expect(ok({ paperType: "cardstock" }).paper).toBe("cardstock");
    expect("paper" in ok({ paperType: "plain" })).toBe(false);
    expect("paper" in ok({})).toBe(false);
    expect("paper" in ok({ paperType: "gold" })).toBe(false);
  });

  it("flip=short is read only for a double-sided, non-booklet job (the form's short-edge control submits it)", () => {
    const flipOf = (f: Record<string, string>) => {
      const r = parseChoices(form({ copies: "1", ...f }));
      if (!r.ok) throw new Error(r.reason);
      return r.choices.flip;
    };
    expect(flipOf({ sides: "two", flip: "short" })).toBe("short");
    expect(flipOf({ sides: "two", flip: "long" })).toBeUndefined();
    expect(flipOf({ sides: "one", flip: "short" })).toBeUndefined();
    expect(flipOf({ sides: "two", booklet: "left", flip: "short" })).toBeUndefined();
  });
});

describe("mapRawChoices: cardstock", () => {
  const profile = {
    capabilities: { duplex: true, staple: true, booklet: true, punch: true },
    bookletBindingSide: "left" as const,
    stapleDefault: "top-left" as const,
    declaredPaperSizes: ["letter", "11x17"],
  };
  const base: PrintChoices = { sides: "one", staple: "none", booklet: "none", copies: 1, pageRange: "" };

  it("sends the cardstock media type to the printer builder and records it, without holding", () => {
    const m = mapRawChoices({ ...base, paper: "cardstock" }, profile);
    expect(m).toMatchObject({ paperType: "cardstock", heldReason: null, pjl: { mediaType: "cardstock" } });
  });
  it("plain paper adds nothing to what the printer builder gets", () => {
    const m = mapRawChoices(base, profile);
    expect(m.paperType).toBeNull();
    expect(m.pjl).not.toHaveProperty("mediaType");
    expect(m.heldReason).toBeNull();
  });
  it("a cardstock booklet is held with a plain reason", () => {
    const m = mapRawChoices({ ...base, sides: "two", booklet: "left", paper: "cardstock" }, profile);
    expect(m.heldReason).toMatch(/booklet cannot be printed on cardstock/i);
  });
  it("a short-edge flip with a corner staple is held (why the form switches instead of letting it through)", () => {
    expect(mapRawChoices({ ...base, sides: "two", flip: "short", staple: "top-left" }, profile).heldReason).toMatch(/short edge/);
  });
});

describe("live summary wording", () => {
  const c = { pages: 4, copies: 1, sides: "one" as const, staple: "none" as const, booklet: "none" as const };
  it("a clean job reads exactly as before (Letter, plain, long edge say nothing)", () => {
    expect(liveSummaryLine({ ...c, size: "letter", paper: "plain", edge: "long" })).toBe("4 pages · 1 copy · single-sided");
    expect(liveSummaryLine(c)).toBe("4 pages · 1 copy · single-sided");
  });
  it("says the short edge, Tabloid and cardstock out loud", () => {
    expect(liveSummaryLine({ ...c, sides: "two", edge: "short" })).toBe("4 pages · 1 copy · double-sided, short edge");
    expect(liveSummaryLine({ ...c, sides: "two", edge: "long" })).toBe("4 pages · 1 copy · double-sided");
    expect(liveSummaryLine({ ...c, size: "tabloid" })).toBe("4 pages · 1 copy · single-sided · Tabloid (11x17)");
    expect(liveSummaryLine({ ...c, paper: "cardstock" })).toBe("4 pages · 1 copy · single-sided · cardstock");
    expect(liveSummaryLine({ ...c, sides: "two", staple: "top-left", punch: false, size: "tabloid", paper: "cardstock" })).toBe(
      "4 pages · 1 copy · double-sided · stapled · Tabloid (11x17) · cardstock",
    );
  });
  it("a booklet is a booklet whatever the edge was (and a Tabloid booklet says so)", () => {
    expect(liveSummaryLine({ ...c, sides: "two", booklet: "left", edge: "short" })).toBe("4 pages · 1 copy · booklet");
    expect(liveSummaryLine({ ...c, sides: "two", booklet: "left", size: "tabloid" })).toBe("4 pages · 1 copy · booklet · Tabloid (11x17)");
  });
  it("the Color section's line", () => {
    expect(summarizeColor({ colorMode: "bw" })).toBe("Black & white");
    expect(summarizeColor({ colorMode: "color" })).toBe("Colour");
  });
});
