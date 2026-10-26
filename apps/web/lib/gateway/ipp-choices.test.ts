import { describe, expect, it } from "vitest";
import { ippFileName, mapIppChoices } from "./ipp-choices";

const LETTER_COL = { "media-size": { "x-dimension": 21590, "y-dimension": 27940 } };

describe("mapIppChoices: what is accepted", () => {
  const cases: Array<[string, Record<string, unknown>, { sides: "one" | "two"; copies: number; pageRange: string }]> = [
    ["nothing at all", {}, { sides: "one", copies: 1, pageRange: "" }],
    ["one-sided", { sides: "one-sided" }, { sides: "one", copies: 1, pageRange: "" }],
    ["long edge", { sides: "two-sided-long-edge" }, { sides: "two", copies: 1, pageRange: "" }],
    ["copies 1", { copies: 1 }, { sides: "one", copies: 1, pageRange: "" }],
    ["copies 99", { copies: 99 }, { sides: "one", copies: 99, pageRange: "" }],
    ["copies as a one-element list", { copies: [7] }, { sides: "one", copies: 7, pageRange: "" }],
    ["one page range", { "page-ranges": [1, 5] }, { sides: "one", copies: 1, pageRange: "1-5" }],
    ["one single page", { "page-ranges": [8, 8] }, { sides: "one", copies: 1, pageRange: "8" }],
    ["several ranges", { "page-ranges": [[1, 5], [8, 8], [10, 12]] }, { sides: "one", copies: 1, pageRange: "1-5, 8, 10-12" }],
    ["empty page-ranges = whole document", { "page-ranges": [] }, { sides: "one", copies: 1, pageRange: "" }],
    ["open-ended upper bound", { "page-ranges": [3, 2147483647] }, { sides: "one", copies: 1, pageRange: "3-" }],
    ["Letter keyword", { media: "na_letter_8.5x11in" }, { sides: "one", copies: 1, pageRange: "" }],
    ["Letter keyword, any case", { media: "NA_LETTER_8.5x11IN" }, { sides: "one", copies: 1, pageRange: "" }],
    ["Letter media-col", { "media-col": LETTER_COL }, { sides: "one", copies: 1, pageRange: "" }],
    [
      "Letter media-col within tolerance",
      { "media-col": { "media-size": { "x-dimension": 21600, "y-dimension": 27900 } } },
      { sides: "one", copies: 1, pageRange: "" },
    ],
    ["media-col with only a tray", { "media-col": { "media-source": "tray-1" } }, { sides: "one", copies: 1, pageRange: "" }],
    ["finishings none", { finishings: 3 }, { sides: "one", copies: 1, pageRange: "" }],
    ["finishings none in a list", { finishings: [3] }, { sides: "one", copies: 1, pageRange: "" }],
    [
      "ignored attributes",
      {
        "orientation-requested": 4,
        "print-quality": 5,
        "print-color-mode": "color",
        "printer-resolution": { x: 600, y: 600, units: 3 },
        "print-scaling": "fit",
        "document-format": "application/pdf",
        "job-name": "x",
        "unheard-of": { a: 1 },
      },
      { sides: "one", copies: 1, pageRange: "" },
    ],
    [
      "a typical Windows job",
      { copies: 2, sides: "two-sided-long-edge", media: "na_letter_8.5x11in", "orientation-requested": 3, finishings: 3 },
      { sides: "two", copies: 2, pageRange: "" },
    ],
    [
      "a typical Android job",
      { copies: 3, sides: "one-sided", "media-col": LETTER_COL, "page-ranges": [2, 4] },
      { sides: "one", copies: 3, pageRange: "2-4" },
    ],
  ];

  it.each(cases)("%s", (_name, attrs, want) => {
    const { choices, heldReason } = mapIppChoices(attrs);
    expect(heldReason).toBeNull();
    expect(choices).toEqual({ sides: want.sides, staple: "none", booklet: "none", copies: want.copies, pageRange: want.pageRange });
  });
});

describe("mapIppChoices: what is held, with a reason", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["copies 0", { copies: 0 }, /copies must be 1 to 99/i],
    ["copies 100", { copies: 100 }, /copies must be 1 to 99/i],
    ["copies negative", { copies: -3 }, /copies must be 1 to 99/i],
    ["copies not a number", { copies: "many" }, /copies must be 1 to 99/i],
    ["unknown sides", { sides: "tumble" }, /does not recognise the sides setting "tumble"/i],
    ["backwards range", { "page-ranges": [5, 1] }, /page range .* could not be read/i],
    ["zero page", { "page-ranges": [0, 3] }, /page range .* could not be read/i],
    ["range of the wrong shape", { "page-ranges": "1-5" }, /page range .* could not be read/i],
    ["three numbers", { "page-ranges": [1, 2, 3] }, /page range .* could not be read/i],
    ["A4 keyword", { media: "iso_a4_210x297mm" }, /paper size iso_a4_210x297mm is not available yet/i],
    ["A4 media-col", { "media-col": { "media-size": { "x-dimension": 21000, "y-dimension": 29700 } } }, /paper size 210 x 297 mm is not available yet/i],
    ["legal keyword", { media: "na_legal_8.5x14in" }, /only Letter/i],
    ["letter keyword but A4 media-col", { media: "na_letter_8.5x11in", "media-col": { "media-size": { "x-dimension": 21000, "y-dimension": 29700 } } }, /not available yet/i],
    ["media of the wrong type", { media: 7 }, /not available yet/i],
    ["unknown finishing 100", { finishings: 100 }, /finishing option \(100\) .* choose it on the website/i],
    ["staple bottom-left (21)", { finishings: 21 }, /finishing option \(21\)/i],
    ["dual staple left (28)", { finishings: 28 }, /finishing option \(28\)/i],
    ["punch (5)", { finishings: 5 }, /finishing option \(5\)/i],
    ["fold (10)", { finishings: 10 }, /finishing option \(10\)/i],
    ["finishings of the wrong type", { finishings: "staple" }, /finishing option/i],
    ["two different staples", { finishings: [20, 22] }, /more than one staple/i],
    ["staple and booklet", { finishings: [20, 13] }, /booklet .* cannot also be stapled/i],
    ["staple on a short-edge flip", { finishings: 20, sides: "two-sided-short-edge" }, /short edge/i],
    ["staple on a landscape page", { finishings: 20, "orientation-requested": 4 }, /only checked on portrait/i],
    ["staple on a reverse-portrait page", { finishings: 22, "orientation-requested": 6 }, /only checked on portrait/i],
  ];

  it.each(cases)("%s", (_name, attrs, reason) => {
    const { choices, heldReason } = mapIppChoices(attrs);
    expect(heldReason).toMatch(reason);
    // A held job never promises finishing.
    expect(choices.staple).toBe("none");
    expect(choices.booklet).toBe("none");
    expect(choices.copies).toBeGreaterThanOrEqual(1);
    expect(choices.copies).toBeLessThanOrEqual(99);
  });

  it("keeps the valid parts of a held request and joins every reason", () => {
    const { choices, heldReason } = mapIppChoices({ copies: 4, sides: "two-sided-short-edge", media: "iso_a4_210x297mm", "page-ranges": [2, 3] });
    expect(choices).toEqual({ sides: "two", flip: "short", staple: "none", booklet: "none", copies: 4, pageRange: "2-3" });
    expect(heldReason).not.toMatch(/short edge/);
    expect(heldReason).toMatch(/iso_a4_210x297mm/);
  });

  it("never echoes markup or control characters from the client into a reason", () => {
    const { heldReason } = mapIppChoices({ media: "<script>alert(1)</script>\u0000" });
    expect(heldReason).not.toMatch(/[<>\u0000]/);
  });
});

describe("mapIppChoices: finishings from the print dialog", () => {
  // [finishings value(s), sides, expected staple, expected booklet, expected sides]
  const ok: Array<[string, Record<string, unknown>, { sides: "one" | "two"; staple: string; booklet: string }]> = [
    ["none", { finishings: 3 }, { sides: "one", staple: "none", booklet: "none" }],
    ["staple (4) = top-left", { finishings: 4 }, { sides: "one", staple: "top-left", booklet: "none" }],
    ["staple-top-left (20)", { finishings: 20 }, { sides: "one", staple: "top-left", booklet: "none" }],
    ["staple-top-right (22)", { finishings: 22 }, { sides: "one", staple: "top-right", booklet: "none" }],
    ["none in a list with staple-top-left", { finishings: [3, 20] }, { sides: "one", staple: "top-left", booklet: "none" }],
    ["same staple twice", { finishings: [20, 20] }, { sides: "one", staple: "top-left", booklet: "none" }],
    ["staple + long edge", { finishings: 20, sides: "two-sided-long-edge" }, { sides: "two", staple: "top-left", booklet: "none" }],
    ["staple + portrait", { finishings: 22, "orientation-requested": 3 }, { sides: "one", staple: "top-right", booklet: "none" }],
  ];
  it.each(ok)("%s is delivered, not held", (_n, attrs, want) => {
    const { choices, heldReason } = mapIppChoices(attrs);
    expect(heldReason).toBeNull();
    expect(choices).toMatchObject(want);
  });

  it("short edge on its own is accepted: double-sided, flip on the short edge, nothing held", () => {
    const { choices, heldReason } = mapIppChoices({ sides: "two-sided-short-edge" });
    expect(heldReason).toBeNull();
    expect(choices).toMatchObject({ sides: "two", flip: "short" });
  });

  it("long edge and one-sided carry no flip choice", () => {
    expect(mapIppChoices({ sides: "two-sided-long-edge" }).choices).not.toHaveProperty("flip");
    expect(mapIppChoices({ sides: "one-sided" }).choices).not.toHaveProperty("flip");
  });

  it("a booklet ignores the flip (short edge is part of every booklet)", () => {
    const { choices, heldReason } = mapIppChoices({ finishings: 13, sides: "two-sided-short-edge" });
    expect(choices).not.toHaveProperty("flip");
    expect(heldReason).not.toMatch(/short edge/);
  });

  it("a corner staple on a short-edge flip is held with a plain reason (the corner is not known)", () => {
    const { heldReason } = mapIppChoices({ finishings: 20, sides: "two-sided-short-edge" });
    expect(heldReason).toMatch(/staple/i);
    expect(heldReason).toMatch(/short edge/i);
  });
});

describe("mapIppChoices: never throws", () => {
  it.each([null, undefined, 5, "x", [], [1, 2], { copies: {} }, { sides: [] }, { "media-col": null }, { "media-col": [] }, { finishings: {} }, { "page-ranges": [[1]] }])(
    "survives %j",
    (input) => {
      expect(() => mapIppChoices(input as never)).not.toThrow();
      const { choices } = mapIppChoices(input as never);
      expect(choices.copies).toBe(1);
    },
  );
});

describe("ippFileName", () => {
  it.each([
    ["Quarterly report", "Quarterly report.pdf"],
    ["Quarterly report.pdf", "Quarterly report.pdf"],
    ["Quarterly report.PDF", "Quarterly report.pdf"],
    ["Résumé final", "Resume final.pdf"],
    ["../../etc/passwd", "etc passwd.pdf"],
    ["a/b\\c:d*e?.docx", "a b c d e .docx.pdf"],
    ["<b>bold</b>", "b bold b.pdf"],
    ["   ...   ", "Print job.pdf"],
    ["", "Print job.pdf"],
    [undefined, "Print job.pdf"],
    [42, "Print job.pdf"],
    ["\u0000\u0007", "Print job.pdf"],
  ])("%j -> %s", (input, want) => {
    expect(ippFileName(input)).toBe(want);
  });

  it("caps the name at 60 characters before .pdf", () => {
    const name = ippFileName("x".repeat(200));
    expect(name).toBe(`${"x".repeat(60)}.pdf`);
  });

  it("only ever produces letters, digits, space, dot, underscore and hyphen", () => {
    expect(ippFileName("日本語 😀 report #1 (final) [v2]")).toMatch(/^[A-Za-z0-9 ._-]+$/);
  });
});

describe("mapIppChoices: booklet from the print dialog is held for a binding choice", () => {
  // The dialog can only say booklet-maker (13) or saddle-stitch (8), never left or right, so the member picks the
  // edge in one tap on the website. The job still carries booklet=true so that card opens with Booklet chosen.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["booklet-maker (13)", { finishings: 13 }],
    ["saddle-stitch (8)", { finishings: 8 }],
    ["booklet-maker + short edge", { finishings: 13, sides: "two-sided-short-edge" }],
    ["booklet-maker + long edge", { finishings: 13, sides: "two-sided-long-edge" }],
    ["booklet-maker + one-sided", { finishings: 13, sides: "one-sided" }],
    ["booklet-maker and saddle-stitch together", { finishings: [13, 8] }],
    ["booklet on a landscape page", { finishings: 13, "orientation-requested": 4 }],
  ];
  it.each(cases)("%s is held with a friendly reason and booklet kept", (_n, attrs) => {
    const { choices, heldReason } = mapIppChoices(attrs);
    expect(heldReason).toBe("Booklet: choose left or right binding.");
    expect(choices.booklet).not.toBe("none");
    expect(choices).toMatchObject({ sides: "two", staple: "none" });
  });

  it("keeps the booklet when another reason also holds the job, and joins the reasons", () => {
    const { choices, heldReason } = mapIppChoices({ finishings: 13, media: "iso_a4_210x297mm" });
    expect(choices.booklet).not.toBe("none");
    expect(heldReason).toMatch(/choose left or right binding/i);
    expect(heldReason).toMatch(/iso_a4_210x297mm/);
  });

  it("a booklet plus a staple is still held with booklet none (nothing is promised)", () => {
    const { choices, heldReason } = mapIppChoices({ finishings: [22, 13] });
    expect(heldReason).toMatch(/cannot also be stapled/i);
    expect(choices.booklet).toBe("none");
  });
});
