import { readBuilderParams, readPagesParam } from "@/lib/booklet/builder-params";
import { paperSizeForForm, type PrintAgainFormChoices } from "@/lib/jobs/print-again";
import { MAX_COPIES, type BookletChoice, type SidesChoice, type StapleChoice } from "@/lib/print-choices";

/**
 * What the print page starts with. Pure (no browser, no database) so the rules are testable on their own.
 *
 * Every visit starts CLEAN: single-sided, 1 copy, all pages, Letter, plain paper, no staple, no punch, no booklet, black and
 * white. Two things may change that, in this order (later wins): the member's remembered choices - only when they switched
 * "Remember my last print choices" on (booklet never comes back) - and then a handoff into the page
 * (?again=<job>, ?booklet=left|right from the booklet builder, ?pages=).
 */

/** The choices the form can remember between visits. Every field is optional: whatever was not stored stays clean. */
export interface RememberedChoices {
  profileId?: string;
  sides?: SidesChoice;
  staple?: StapleChoice;
  booklet?: BookletChoice;
  bookletFit?: "fill" | "keep";
  bookletSheet?: "letter" | "tabloid";
  copies?: number;
  colorMode?: "bw" | "color";
  paperSize?: string;
  punch?: boolean;
}

export const CLEAN_START = {
  sides: "one" as SidesChoice,
  staple: "none" as StapleChoice,
  booklet: "none" as BookletChoice,
  copies: 1,
  colorMode: "bw" as "bw" | "color",
  paperSize: "letter",
  punch: false,
  bookletFit: "fill" as "fill" | "keep",
  bookletSheet: "letter" as "letter" | "tabloid",
  flip: "long" as "long" | "short",
  pagesMode: "all" as "all" | "range",
  pageRange: "",
};

/**
 * Anything stored (a database column) is untrusted: keep only values the form understands, field by field, and ignore
 * the rest. Never throws; junk or a non-object gives {}.
 */
export function parseRememberedChoices(raw: unknown): RememberedChoices {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const v = raw as Record<string, unknown>;
  const out: RememberedChoices = {};
  if (typeof v.profileId === "string" && v.profileId.length > 0 && v.profileId.length <= 64) out.profileId = v.profileId;
  if (v.sides === "one" || v.sides === "two") out.sides = v.sides;
  if (v.staple === "none" || v.staple === "top-left" || v.staple === "top-right" || v.staple === "dual-left") out.staple = v.staple;
  if (v.booklet === "none" || v.booklet === "left" || v.booklet === "right") out.booklet = v.booklet;
  if (typeof v.copies === "number" && Number.isInteger(v.copies) && v.copies >= 1 && v.copies <= MAX_COPIES) out.copies = v.copies;
  if (v.colorMode === "bw" || v.colorMode === "color") out.colorMode = v.colorMode;
  if (typeof v.paperSize === "string" && v.paperSize.length > 0 && v.paperSize.length <= 40) out.paperSize = v.paperSize;
  if (typeof v.punch === "boolean") out.punch = v.punch;
  if (v.bookletFit === "fill" || v.bookletFit === "keep") out.bookletFit = v.bookletFit;
  if (v.bookletSheet === "letter" || v.bookletSheet === "tabloid") out.bookletSheet = v.bookletSheet;
  return out;
}

/**
 * What the form may start from when the setting is on. Booklet ALWAYS starts off, and a booklet forces double-sided, so when
 * the last job was a booklet the stored sides value says nothing about what the person wants: fall back to the clean one.
 */
export function rememberedForForm(stored: unknown): RememberedChoices {
  const c = parseRememberedChoices(stored);
  if (c.booklet && c.booklet !== "none") delete c.sides;
  delete c.booklet;
  return c;
}

export interface StartChoices {
  /** null = keep the form's own first printer. */
  profileId: string | null;
  sides: SidesChoice;
  staple: StapleChoice;
  booklet: BookletChoice;
  copies: number;
  colorMode: "bw" | "color";
  paperSize: string;
  punch: boolean;
  bookletFit: "fill" | "keep";
  bookletSheet: "letter" | "tabloid";
  flip: "long" | "short";
  flipOffered: boolean;
  pagesMode: "all" | "range";
  pageRange: string;
  /** Coming from the booklet builder: show the booklet preview without a press. */
  autoPreview: boolean;
}

export function resolveStartChoices(input: {
  printers: { id: string; declaredPaperSizes: readonly string[] }[];
  /** Already passed through rememberedForForm on the server; only present when the member's setting is on. */
  remembered?: RememberedChoices | null;
  again?: PrintAgainFormChoices | null;
  /** window.location.search */
  search: string;
}): StartChoices {
  const { printers, remembered, again, search } = input;
  const r = remembered ?? {};
  const out: StartChoices = {
    profileId: r.profileId && printers.some((p) => p.id === r.profileId) ? r.profileId : null,
    sides: r.sides ?? CLEAN_START.sides,
    staple: r.staple ?? CLEAN_START.staple,
    booklet: CLEAN_START.booklet, // never remembered
    copies: r.copies ?? CLEAN_START.copies,
    colorMode: r.colorMode ?? CLEAN_START.colorMode,
    paperSize: r.paperSize ?? CLEAN_START.paperSize,
    punch: r.punch ?? CLEAN_START.punch,
    bookletFit: r.bookletFit ?? CLEAN_START.bookletFit,
    bookletSheet: r.bookletSheet ?? CLEAN_START.bookletSheet,
    flip: CLEAN_START.flip,
    flipOffered: false,
    pagesMode: CLEAN_START.pagesMode,
    pageRange: CLEAN_START.pageRange,
    autoPreview: false,
  };

  // "Print again": everything the earlier job used, over the remembered choices.
  if (again) {
    const againProfile = printers.find((p) => p.id === again.profileId) ?? printers.find((p) => p.id === out.profileId) ?? printers[0];
    if (againProfile) out.profileId = againProfile.id;
    out.sides = again.sides;
    out.staple = again.staple;
    out.booklet = again.booklet;
    out.copies = again.copies;
    out.colorMode = again.colorMode;
    out.paperSize = paperSizeForForm(again.paperSize, againProfile?.declaredPaperSizes ?? []);
    out.punch = again.punch;
    out.bookletFit = again.bookletFit;
    out.bookletSheet = again.bookletSheet;
    out.flip = again.flip ?? "long";
    out.flipOffered = again.flip === "short";
    if (again.pageRange) {
      out.pagesMode = "range";
      out.pageRange = again.pageRange;
    }
  }

  // Coming from the booklet builder: ?booklet=left|right switches the booklet on for the built file.
  const fromBuilder = readBuilderParams(search);
  if (fromBuilder.booklet) {
    out.booklet = fromBuilder.booklet;
    if (fromBuilder.sheet) out.bookletSheet = fromBuilder.sheet;
    out.autoPreview = true;
  }

  // One file picked in the library with the pages to use (a source's cover and dedication pages are skipped).
  const pagesFromLibrary = readPagesParam(search);
  if (pagesFromLibrary) {
    out.pagesMode = "range";
    out.pageRange = pagesFromLibrary;
  }
  return out;
}
