import { describe, expect, it } from "vitest";
import {
  buildSummary,
  describeAvailability,
  mapQueueChoices,
  mapRawChoices,
  parseChoices,
  checkQueueCapabilities,
  planPageSubset,
  type PrintChoices,
  type RawProfileContext,
} from "./print-choices";

const CAPS = { duplex: true, staple: true, booklet: true };
const PROFILE: RawProfileContext = { capabilities: CAPS, bookletBindingSide: "left", stapleDefault: "top-left", declaredPaperSizes: ["letter", "11x17"] };

function choices(over: Partial<PrintChoices> = {}): PrintChoices {
  return { sides: "two", staple: "none", booklet: "none", copies: 1, pageRange: "", ...over };
}

function fd(entries: Record<string, string>) {
  return (name: string) => (name in entries ? entries[name]! : null);
}

function okChoices(get: (name: string) => string | null): PrintChoices {
  const r = parseChoices(get);
  if (!r.ok) throw new Error(r.reason);
  return r.choices;
}

describe("parseChoices", () => {
  it("reads the form contract", () => {
    expect(parseChoices(fd({ sides: "two", staple: "top-right", booklet: "none", copies: "3", pageRange: " 1-5, 8 " }))).toEqual({
      ok: true,
      choices: { sides: "two", staple: "top-right", booklet: "none", copies: 3, pageRange: "1-5, 8" },
    });
  });

  it("falls back to safe values for missing or junk fields", () => {
    expect(parseChoices(fd({ sides: "one", staple: "bottom-left", booklet: "up", copies: "-4" }))).toEqual({
      ok: true,
      choices: { sides: "one", staple: "none", booklet: "none", copies: 1, pageRange: "" },
    });
    expect(okChoices(fd({ sides: "one", copies: "abc" })).copies).toBe(1);
    expect(okChoices(fd({ sides: "one", copies: "2.9" })).copies).toBe(2);
  });

  it("treats a missing sides field as two-sided when a booklet is chosen (a booklet is always double-sided)", () => {
    expect(okChoices(fd({ booklet: "right" })).sides).toBe("two");
  });

  it("rejects a missing or junk sides value for a non-booklet job instead of guessing single-sided", () => {
    for (const entries of [{}, { sides: "x" }, { sides: "", booklet: "none" }] as Record<string, string>[]) {
      const r = parseChoices(fd(entries));
      expect(r.ok).toBe(false);
    }
  });
});

describe("mapRawChoices", () => {
  it("maps double-sided + top-left staple", () => {
    const r = mapRawChoices(choices({ staple: "top-left", copies: 2 }), PROFILE);
    expect(r).toMatchObject({
      duplex: true,
      finishing: { staple: true, booklet: false, punch: false },
      staplePosition: "top-left",
      bindingSide: null,
      colorMode: "bw",
      paperSize: "letter",
      copies: 2,
      heldReason: null,
    });
    expect(r.pjl).toMatchObject({ copies: 2, duplex: true, staple: "top-left", booklet: false });
  });

  it("maps one-sided + top-right staple", () => {
    const r = mapRawChoices(choices({ sides: "one", staple: "top-right" }), PROFILE);
    expect(r.duplex).toBe(false);
    expect(r.staplePosition).toBe("top-right");
    expect(r.heldReason).toBeNull();
  });

  it("maps plain one-sided with no finishing", () => {
    const r = mapRawChoices(choices({ sides: "one" }), PROFILE);
    expect(r).toMatchObject({ duplex: false, staplePosition: null, bindingSide: null, finishing: { staple: false, booklet: false } });
    expect(r.heldReason).toBeNull();
  });

  it("maps a left and a right booklet; a booklet is always two-sided and carries its binding side", () => {
    const left = mapRawChoices(choices({ sides: "one", booklet: "left" }), PROFILE);
    expect(left).toMatchObject({ duplex: true, bindingSide: "left", staplePosition: null, finishing: { booklet: true, staple: false } });
    expect(left.heldReason).toBeNull();
    expect(left.pjl).toMatchObject({ booklet: true, bindingSide: "left" });
    const right = mapRawChoices(choices({ booklet: "right" }), PROFILE);
    expect(right.bindingSide).toBe("right");
    expect(right.heldReason).toBeNull();
  });

  it("uses the printer's own binding side for a re-print of an old booklet job ('profile')", () => {
    const r = mapRawChoices(choices({ booklet: "profile" }), { ...PROFILE, bookletBindingSide: "right" });
    expect(r.bindingSide).toBe("right");
    expect(r.heldReason).toBeNull();
  });

  it("uses the printer's own staple corner for a re-print of an old stapled job ('profile')", () => {
    const r = mapRawChoices(choices({ staple: "profile" }), { ...PROFILE, stapleDefault: "top-right" });
    expect(r.staplePosition).toBe("top-right");
    expect(r.finishing.staple).toBe(true);
    expect(r.heldReason).toBeNull();
  });

  it("holds (does not guess) a booklet combined with a staple", () => {
    const r = mapRawChoices(choices({ booklet: "left", staple: "top-left" }), PROFILE);
    expect(r.heldReason).toMatch(/booklet/i);
    expect(r.heldReason).toMatch(/staple/i);
    expect(r.heldReason).not.toMatch(/profile|queue/i);
  });

  it("holds options the printer does not offer", () => {
    expect(mapRawChoices(choices({ staple: "top-left" }), { ...PROFILE, capabilities: { ...CAPS, staple: false } }).heldReason).toMatch(/staple/i);
    expect(mapRawChoices(choices({ booklet: "left" }), { ...PROFILE, capabilities: { ...CAPS, booklet: false } }).heldReason).toMatch(/booklet/i);
    expect(mapRawChoices(choices({ sides: "two" }), { ...PROFILE, capabilities: { ...CAPS, duplex: false } }).heldReason).toMatch(/double-sided/i);
  });

  it("holds when the shared PJL builder rejects the options (single source of truth)", () => {
    expect(mapRawChoices(choices({ copies: 0 }), PROFILE).heldReason).not.toBeNull();
  });

  it("picks letter, else the first declared size, as the paper size", () => {
    expect(mapRawChoices(choices(), { ...PROFILE, declaredPaperSizes: ["11x17"] }).paperSize).toBe("11x17");
    expect(mapRawChoices(choices(), { ...PROFILE, declaredPaperSizes: [] }).paperSize).toBe("letter");
  });
});

describe("mapQueueChoices", () => {
  it("keeps queue jobs on plain flags and never stores a staple corner", () => {
    const r = mapQueueChoices(choices({ staple: "top-left", copies: 2 }), { bookletBindingSide: "right" });
    expect(r).toMatchObject({ duplex: true, staple: true, booklet: false, staplePosition: null, bindingSide: null, copies: 2 });
  });
  it("a booklet is two-sided and stores its binding side (job choice, else the printer's)", () => {
    expect(mapQueueChoices(choices({ sides: "one", booklet: "left" }), { bookletBindingSide: "right" })).toMatchObject({
      duplex: true,
      booklet: true,
      bindingSide: "left",
    });
    expect(mapQueueChoices(choices({ booklet: "profile" }), { bookletBindingSide: "right" }).bindingSide).toBe("right");
  });
});

describe("describeAvailability", () => {
  it("allows everything on a fully capable printer with nothing chosen", () => {
    expect(describeAvailability({ staple: "none", booklet: "none" }, CAPS)).toEqual({
      sidesLocked: false,
      stapleDisabledReason: null,
      bookletDisabledReason: null,
    });
  });
  it("a booklet locks two-sided and disables staple, with a reason", () => {
    const a = describeAvailability({ staple: "none", booklet: "left" }, CAPS);
    expect(a.sidesLocked).toBe(true);
    expect(a.stapleDisabledReason).toMatch(/booklet/i);
  });
  it("a chosen staple disables the booklet, with a reason", () => {
    expect(describeAvailability({ staple: "top-left", booklet: "none" }, CAPS).bookletDisabledReason).toMatch(/staple/i);
  });
  it("queue printers may combine a booklet with a staple (only raw printers cannot)", () => {
    const a = describeAvailability({ staple: "top-left", booklet: "left" }, CAPS, { exclusive: false });
    expect(a.stapleDisabledReason).toBeNull();
    expect(a.bookletDisabledReason).toBeNull();
  });
  it("a printer without double-sided printing cannot make booklets, and says why", () => {
    const a = describeAvailability({ staple: "none", booklet: "none" }, { ...CAPS, duplex: false });
    expect(a.bookletDisabledReason).toMatch(/double-sided/i);
  });
  it("explains options the printer does not declare", () => {
    const a = describeAvailability({ staple: "none", booklet: "none" }, { duplex: true, staple: false, booklet: false });
    expect(a.stapleDisabledReason).toMatch(/staple/i);
    expect(a.bookletDisabledReason).toMatch(/booklet/i);
  });
});

describe("buildSummary", () => {
  it("says what will print in plain words, with the sheet count", () => {
    const r = buildSummary({ pages: 10, copies: 2, sides: "two", staple: "top-left", booklet: "none" });
    expect(r).toMatchObject({ sheets: 10, printedSides: 20, blankPagesAdded: 0 });
    expect(r?.text).toBe("10 pages, 2 copies, double-sided, stapled top-left = 10 sheets");
  });
  it("handles one page, one copy, one-sided", () => {
    expect(buildSummary({ pages: 1, copies: 1, sides: "one", staple: "none", booklet: "none" })?.text).toBe(
      "1 page, 1 copy, single-sided = 1 sheet",
    );
  });
  it("counts a booklet in padded groups of four and reports the blank pages added", () => {
    const r = buildSummary({ pages: 10, copies: 1, sides: "one", staple: "none", booklet: "right" });
    expect(r).toMatchObject({ sheets: 3, blankPagesAdded: 2 });
    expect(r?.text).toContain("booklet, bound on the right");
    expect(r?.text).toContain("= 3 sheets");
  });
  it("returns null when there is nothing to count yet", () => {
    expect(buildSummary({ pages: null, copies: 1, sides: "one", staple: "none", booklet: "none" })).toBeNull();
    expect(buildSummary({ pages: 0, copies: 1, sides: "one", staple: "none", booklet: "none" })).toBeNull();
  });
});

describe("checkQueueCapabilities", () => {
  const all = { duplex: true, staple: true, booklet: true, punch: true };
  const none = { duplex: false, staple: false, booklet: false, punch: false };
  it("accepts anything the profile declares", () => {
    expect(checkQueueCapabilities({ duplex: true, staple: true, booklet: true, punch: true }, all)).toBeNull();
  });
  it("accepts a plain single-sided job on a printer that declares nothing", () => {
    expect(checkQueueCapabilities({ duplex: false, staple: false, booklet: false, punch: false }, none)).toBeNull();
  });
  it("rejects each undeclared option with a clear message", () => {
    expect(checkQueueCapabilities({ duplex: false, staple: false, booklet: true, punch: false }, { ...all, booklet: false })).toMatch(/booklet/i);
    expect(checkQueueCapabilities({ duplex: false, staple: true, booklet: false, punch: false }, { ...all, staple: false })).toMatch(/staple/i);
    expect(checkQueueCapabilities({ duplex: true, staple: false, booklet: false, punch: false }, { ...all, duplex: false })).toMatch(/double-sided/i);
    expect(checkQueueCapabilities({ duplex: false, staple: false, booklet: false, punch: true }, { ...all, punch: false })).toMatch(/punch/i);
  });
  it("treats missing capabilities as not declared", () => {
    expect(checkQueueCapabilities({ duplex: false, staple: true, booklet: false, punch: false }, null)).toMatch(/staple/i);
  });
});

describe("planPageSubset", () => {
  it("builds no subset for a held job, but still validates the range and counts the pages", () => {
    expect(planPageSubset({ pageRangeText: "2-3", pageCount: 10, held: true })).toEqual({ ok: true, sourcePages: 2, subsetPages: null });
    const bad = planPageSubset({ pageRangeText: "99", pageCount: 10, held: true });
    expect(bad.ok).toBe(false);
  });
  it("asks for a subset when printing part of the document", () => {
    expect(planPageSubset({ pageRangeText: "2-3", pageCount: 10, held: false })).toEqual({ ok: true, sourcePages: 2, subsetPages: [2, 3] });
  });
  it("needs no subset for an empty range or the whole document", () => {
    expect(planPageSubset({ pageRangeText: null, pageCount: 4, held: false })).toEqual({ ok: true, sourcePages: 4, subsetPages: null });
    expect(planPageSubset({ pageRangeText: "1-4", pageCount: 4, held: false })).toEqual({ ok: true, sourcePages: 4, subsetPages: null });
  });
});
