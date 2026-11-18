import { describe, expect, it } from "vitest";
import type { PrintAgainFormChoices } from "@/lib/jobs/print-again";
import { CLEAN_START, parseRememberedChoices, rememberedForForm, resolveStartChoices } from "./print-start-choices";

const printers = [
  { id: "p1", declaredPaperSizes: ["letter", "legal"] },
  { id: "p2", declaredPaperSizes: ["letter", "11x17"] },
];

const again: PrintAgainFormChoices = {
  profileId: "p2",
  sides: "two",
  flip: "short",
  paper: "plain",
  staple: "top-left",
  booklet: "none",
  copies: 4,
  punch: true,
  pageRange: "2-5",
  colorMode: "color",
  paperSize: "tabloid",
  bookletFit: "keep",
  bookletSheet: "tabloid",
};

describe("clean start", () => {
  it("is single-sided, 1 copy, all pages, Letter, plain paper, no staple, no punch, no booklet, black and white", () => {
    expect(resolveStartChoices({ printers, search: "" })).toEqual({
      profileId: null,
      sides: "one",
      staple: "none",
      booklet: "none",
      copies: 1,
      colorMode: "bw",
      paperSize: "letter",
      size: "letter",
      paper: "plain",
      punch: false,
      bookletFit: "fill",
      bookletSheet: "letter",
      flip: "long",
      pagesMode: "all",
      pageRange: "",
      autoPreview: false,
    });
    expect(CLEAN_START.sides).toBe("one");
  });

  it("is also what you get when the remembered setting is off (nothing handed over) or empty", () => {
    expect(resolveStartChoices({ printers, remembered: null, search: "" })).toEqual(resolveStartChoices({ printers, search: "" }));
    expect(resolveStartChoices({ printers, remembered: {}, search: "" })).toEqual(resolveStartChoices({ printers, search: "" }));
  });
});

describe("remembered choices (setting on)", () => {
  const last = {
    profileId: "p2",
    sides: "two",
    staple: "top-right",
    booklet: "left",
    copies: 7,
    colorMode: "color",
    paperSize: "legal",
    punch: true,
    bookletFit: "keep",
    bookletSheet: "tabloid",
  };

  it("restores everything except the booklet", () => {
    const c = resolveStartChoices({ printers, remembered: rememberedForForm({ ...last, booklet: "none" }), search: "" });
    expect(c).toMatchObject({ profileId: "p2", sides: "two", staple: "top-right", booklet: "none", copies: 7, colorMode: "color", paperSize: "legal", punch: true, bookletFit: "keep", bookletSheet: "tabloid" });
  });

  it("starts with the booklet off even when the last job was a booklet, and falls back to the clean sides value", () => {
    const remembered = rememberedForForm(last);
    expect(remembered.booklet).toBeUndefined();
    expect(remembered.sides).toBeUndefined();
    const c = resolveStartChoices({ printers, remembered, search: "" });
    expect(c.booklet).toBe("none");
    expect(c.sides).toBe(CLEAN_START.sides);
    expect(c.copies).toBe(7); // the rest still comes back
  });

  it("ignores a remembered printer that is no longer there", () => {
    expect(resolveStartChoices({ printers, remembered: { profileId: "gone" }, search: "" }).profileId).toBeNull();
  });
});

describe("invalid stored data", () => {
  it("is ignored field by field, never trusted", () => {
    expect(
      parseRememberedChoices({ sides: "three", staple: "everywhere", booklet: 5, copies: 0, colorMode: "rainbow", paperSize: 7, punch: "yes", bookletFit: "x", bookletSheet: "huge", profileId: "" }),
    ).toEqual({});
    expect(parseRememberedChoices({ copies: 100 })).toEqual({});
    expect(parseRememberedChoices({ copies: 2.5 })).toEqual({});
    expect(parseRememberedChoices({ paperSize: "x".repeat(41) })).toEqual({});
    expect(parseRememberedChoices({ sides: "two", junk: { a: 1 }, copies: 3 })).toEqual({ sides: "two", copies: 3 });
  });

  it("gives {} for anything that is not an object", () => {
    for (const bad of [null, undefined, "two", 5, true, [], ["sides"]]) expect(parseRememberedChoices(bad)).toEqual({});
    expect(rememberedForForm("garbage")).toEqual({});
  });
});

describe("handoffs win over remembered choices", () => {
  const remembered = { profileId: "p1", sides: "two" as const, copies: 9, paperSize: "legal", pageRange: "ignored" } as never;

  it("?booklet=right&sheet=tabloid switches the booklet on, picks the sheet, and asks for the preview", () => {
    const c = resolveStartChoices({ printers, remembered: { copies: 9, bookletSheet: "letter" }, search: "?built=1&booklet=right&sheet=tabloid" });
    expect(c).toMatchObject({ booklet: "right", bookletSheet: "tabloid", autoPreview: true, copies: 9 });
  });

  it("?booklet=left without a sheet keeps the remembered sheet", () => {
    const c = resolveStartChoices({ printers, remembered: { bookletSheet: "tabloid" }, search: "?booklet=left" });
    expect(c).toMatchObject({ booklet: "left", bookletSheet: "tabloid", autoPreview: true });
  });

  it("?pages= sets the page range", () => {
    expect(resolveStartChoices({ printers, remembered, search: "?built=1&pages=4-18" })).toMatchObject({ pagesMode: "range", pageRange: "4-18" });
    expect(resolveStartChoices({ printers, search: "?pages=7" })).toMatchObject({ pagesMode: "range", pageRange: "7" });
  });

  it("an invalid ?pages= or ?booklet= is ignored", () => {
    expect(resolveStartChoices({ printers, search: "?pages=abc&booklet=up" })).toMatchObject({ pagesMode: "all", pageRange: "", booklet: "none", autoPreview: false });
  });

  it("?built=1 and ?shared=1 alone change nothing (the files arrive separately)", () => {
    expect(resolveStartChoices({ printers, search: "?built=1&shared=1" })).toEqual(resolveStartChoices({ printers, search: "" }));
  });

  it("print again applies everything the earlier job used, over clean AND over remembered choices", () => {
    for (const rem of [undefined, { profileId: "p1", sides: "one" as const, copies: 2, colorMode: "bw" as const, paperSize: "legal", punch: false }]) {
      const c = resolveStartChoices({ printers, remembered: rem, again, search: "" });
      expect(c).toMatchObject({
        profileId: "p2",
        sides: "two",
        staple: "top-left",
        booklet: "none",
        copies: 4,
        colorMode: "color",
        paperSize: "11x17",
        punch: true,
        bookletFit: "keep",
        bookletSheet: "tabloid",
        flip: "short",
        size: "tabloid",
        paper: "plain",
        pagesMode: "range",
        pageRange: "2-5",
      });
    }
  });

  it("print again falls back to the remembered printer, then the first one, when the old printer is gone", () => {
    const gone = { ...again, profileId: "gone" };
    expect(resolveStartChoices({ printers, remembered: { profileId: "p2" }, again: gone, search: "" }).profileId).toBe("p2");
    expect(resolveStartChoices({ printers, again: gone, search: "" }).profileId).toBe("p1");
  });

  it("a builder handoff on top of print again still wins for the booklet", () => {
    expect(resolveStartChoices({ printers, again, search: "?booklet=left" })).toMatchObject({ booklet: "left", copies: 4 });
  });
});
