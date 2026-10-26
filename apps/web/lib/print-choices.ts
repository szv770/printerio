/**
 * The upload page's plain choices (sides / staple / booklet / copies / page
 * range) and what each one turns into. Pure, no server-only imports, so the
 * upload form (live summary, disabling) and the server action (the authority)
 * run exactly the same rules.
 *
 * Principle (docs/superpowers/specs/2026-10-20-printio-setup-design.md): never
 * guess finishing. For a printer that prints on the raw port, anything the
 * shared PJL builder cannot map (packages/shared/src/pjl.ts is the single
 * source of truth) or that the printer does not offer comes back as a
 * `heldReason`, and the caller holds the job instead of printing something else.
 */
import { buildPjlSettings, computeBookletPadding, computePrintMath, parsePageRange, type RawPrintOptions } from "@printio/shared";

export type SidesChoice = "one" | "two";
/** "profile" is internal only (re-printing an old job that never stored a corner): use the printer's own default. */
export type StapleChoice = "none" | "top-left" | "top-right" | "profile";
/** Which edge the booklet is bound on. "profile" is internal only (re-printing an old job that never stored a side). */
export type BookletChoice = "none" | "left" | "right" | "profile";
export type BindingSide = "left" | "right";
export type StaplePosition = "top-left" | "top-right";

export interface PrintChoices {
  sides: SidesChoice;
  staple: StapleChoice;
  booklet: BookletChoice;
  copies: number;
  /** Double-sided only: "short" flips on the short edge (like a notepad). Absent = the usual long edge. */
  flip?: "short";
  /** Raw text as typed ("1-5, 8"); empty = the whole document. Parsed with parsePageRange. */
  pageRange: string;
}

export interface ChoiceCapabilities {
  duplex: boolean;
  staple: boolean;
  booklet: boolean;
}

export const MAX_COPIES = 99;

export type ParsedChoices = { ok: true; choices: PrintChoices } | { ok: false; reason: string };

/**
 * Reads the form contract from FormData (or anything with a get). Junk staple/booklet/copies fall back to the
 * safe choice; a missing or junk `sides` is an explicit error for a non-booklet job (never silently single-sided).
 */
export function parseChoices(get: (name: string) => FormDataEntryValue | null): ParsedChoices {
  const str = (name: string) => {
    const v = get(name);
    return typeof v === "string" ? v : "";
  };
  const booklet: BookletChoice = str("booklet") === "left" ? "left" : str("booklet") === "right" ? "right" : "none";
  const staple: StapleChoice = str("staple") === "top-left" ? "top-left" : str("staple") === "top-right" ? "top-right" : "none";
  // A booklet is always double-sided, so its `sides` value is irrelevant. For anything else the form always
  // sends `sides` (Segmented submits a hidden input even when its control is locked), so a missing or junk value
  // means a broken request: refuse it rather than guess.
  const rawSides = str("sides");
  let sides: SidesChoice;
  if (rawSides === "one" || rawSides === "two") sides = rawSides;
  else if (booklet !== "none") sides = "two";
  else return { ok: false, reason: "Choose single-sided or double-sided." };
  const n = parseInt(str("copies"), 10);
  const copies = Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_COPIES) : 1;
  const flip = sides === "two" && booklet === "none" && str("flip") === "short" ? ({ flip: "short" } as const) : {};
  return { ok: true, choices: { sides, staple, booklet, copies, ...flip, pageRange: str("pageRange").trim() } };
}

export type PageSubsetPlan =
  | { ok: true; sourcePages: number; /** Pages to pull out into a subset PDF, or null when no subset is needed (or the job is held). */ subsetPages: number[] | null }
  | { ok: false; reason: string };

/**
 * Decides what the page range means before any PDF work. A held job never builds a subset (it stores the
 * original only and the range text is re-applied on release) but its range is still validated and counted
 * so the estimate is right.
 */
export function planPageSubset(input: { pageRangeText: string | null; pageCount: number; held: boolean }): PageSubsetPlan {
  const { pageRangeText, pageCount, held } = input;
  if (!pageRangeText) return { ok: true, sourcePages: pageCount, subsetPages: null };
  const parsed = parsePageRange(pageRangeText, pageCount);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const whole = parsed.pages.length === pageCount && parsed.pages.every((p, i) => p === i + 1);
  return { ok: true, sourcePages: parsed.pages.length, subsetPages: held || whole ? null : parsed.pages };
}

/**
 * Windows-queue printers: the requested options must be declared by the profile. Returns a plain message for
 * the first one that is not, else null. (Raw profiles check this inside mapRawChoices.)
 */
export function checkQueueCapabilities(
  requested: { duplex: boolean; staple: boolean; booklet: boolean; punch: boolean },
  declared: { duplex?: boolean; staple?: boolean; booklet?: boolean; punch?: boolean } | null,
): string | null {
  if (requested.booklet && !declared?.booklet) return "This printer can't make booklets. Turn the booklet option off.";
  if (requested.staple && !declared?.staple) return "This printer can't staple. Turn the staple option off.";
  if (requested.duplex && !declared?.duplex) return "This printer can't print double-sided. Choose single-sided.";
  if (requested.punch && !declared?.punch) return "This printer can't punch holes. Turn the hole punch option off.";
  return null;
}

export interface RawProfileContext {
  capabilities: ChoiceCapabilities;
  /** printer_profiles.booklet_binding_side - used only when the job itself did not say. */
  bookletBindingSide: BindingSide;
  /** printer_profiles.raw_staple_position - used only when the job itself did not say. */
  stapleDefault: StaplePosition;
  declaredPaperSizes: readonly string[];
}

export interface MappedRawOptions {
  duplex: boolean;
  finishing: { staple: boolean; booklet: boolean; punch: false };
  /** print_jobs.staple_position: non-null exactly when the job is stapled. */
  staplePosition: StaplePosition | null;
  /** print_jobs.booklet_binding_side: non-null exactly for booklet jobs. */
  bindingSide: BindingSide | null;
  /** Colour is not a visible choice on the upload page for raw printers (mono is unverified): the stored default. */
  colorMode: "bw";
  paperSize: string;
  copies: number;
  /** "short" when the sheet flips on the short edge (double-sided, not a booklet); null = the usual long edge. */
  duplexEdge: "short" | null;
  /** What the Agent will hand to buildPjlSettings, minus the job name. */
  pjl: Omit<RawPrintOptions, "jobName">;
  /** Plain-language reason the job must be held instead of printed, or null. */
  heldReason: string | null;
}

function resolveBinding(booklet: BookletChoice, profileSide: BindingSide): BindingSide | null {
  if (booklet === "left" || booklet === "right") return booklet;
  if (booklet === "profile") return profileSide;
  return null;
}

/** Turns the plain choices into what a raw-port job stores and sends. Decides, but never throws. */
export function mapRawChoices(c: PrintChoices, profile: RawProfileContext): MappedRawOptions {
  const isBooklet = c.booklet !== "none";
  const bindingSide = resolveBinding(c.booklet, profile.bookletBindingSide);
  // A booklet is always printed double-sided (short-edge flip is part of the proven booklet settings).
  const duplex = isBooklet || c.sides === "two";
  const duplexEdge: "short" | null = !isBooklet && c.sides === "two" && c.flip === "short" ? "short" : null;
  const stapled = c.staple !== "none";
  const staplePosition: StaplePosition | null =
    c.staple === "top-left" || c.staple === "top-right" ? c.staple : c.staple === "profile" ? profile.stapleDefault : null;
  const paperSize = profile.declaredPaperSizes.includes("letter") ? "letter" : (profile.declaredPaperSizes[0] ?? "letter");

  const pjl: Omit<RawPrintOptions, "jobName"> = {
    copies: c.copies,
    colorMode: "bw",
    duplex,
    ...(duplexEdge ? { duplexEdge } : {}),
    ...(staplePosition ? { staple: staplePosition } : {}),
    booklet: isBooklet,
    ...(bindingSide ? { bindingSide } : {}),
  };

  let heldReason: string | null = null;
  if (isBooklet && stapled) {
    heldReason = "A booklet is stapled for you, so it cannot also be stapled in a corner. Choose either a booklet or a staple.";
  } else if (stapled && !profile.capabilities.staple) {
    heldReason = "This printer is not set up to staple, so nothing was printed.";
  } else if (isBooklet && !profile.capabilities.booklet) {
    heldReason = "This printer is not set up to make booklets, so nothing was printed.";
  } else if (duplex && !profile.capabilities.duplex) {
    heldReason = "This printer is not set up for double-sided printing, so nothing was printed.";
  } else if (duplexEdge && stapled) {
    heldReason = "A corner staple cannot be combined with a flip on the short edge yet, so nothing was printed.";
  } else {
    // The shared builder is the single source of truth for what the printer is known to do.
    const built = buildPjlSettings({ ...pjl, jobName: "Printio" });
    if (!built.ok) heldReason = `Printio could not safely send these options to the printer (${built.reason}).`;
  }

  return {
    duplex,
    finishing: { staple: stapled, booklet: isBooklet, punch: false },
    staplePosition,
    bindingSide,
    duplexEdge,
    colorMode: "bw",
    paperSize,
    copies: c.copies,
    pjl,
    heldReason,
  };
}

export interface MappedQueueOptions {
  duplex: boolean;
  staple: boolean;
  booklet: boolean;
  /** Always null: a Windows queue's staple corner is fixed by the queue itself. */
  staplePosition: null;
  bindingSide: BindingSide | null;
  copies: number;
}

/** Queue-mode printers keep their plain on/off flags; the booklet binding side is now stored per job too. */
export function mapQueueChoices(c: PrintChoices, profile: { bookletBindingSide: BindingSide }): MappedQueueOptions {
  const booklet = c.booklet !== "none";
  return {
    duplex: booklet || c.sides === "two",
    staple: c.staple !== "none",
    booklet,
    staplePosition: null,
    bindingSide: resolveBinding(c.booklet, profile.bookletBindingSide),
    copies: c.copies,
  };
}

export interface ChoiceAvailability {
  /** True when the sides control must show two-sided and not be changed (a booklet is always double-sided). */
  sidesLocked: boolean;
  stapleDisabledReason: string | null;
  bookletDisabledReason: string | null;
}

/**
 * Which controls are usable right now and, when not, why - shown inline next to the control.
 * `exclusive` (default true) is the raw-printer rule that a booklet and a corner staple cannot be combined;
 * a Windows-queue printer keeps its old behaviour of allowing both.
 */
export function describeAvailability(
  current: { staple: StapleChoice; booklet: BookletChoice },
  caps: ChoiceCapabilities,
  opts: { exclusive?: boolean } = {},
): ChoiceAvailability {
  const exclusive = opts.exclusive ?? true;
  const bookletOn = current.booklet !== "none";
  const stapleOn = current.staple !== "none";
  return {
    sidesLocked: bookletOn,
    stapleDisabledReason: !caps.staple
      ? "This printer can't staple."
      : exclusive && bookletOn
        ? "A booklet is stapled for you. Turn the booklet off to staple in a corner."
        : null,
    bookletDisabledReason: !caps.booklet
      ? "This printer can't make booklets."
      : !caps.duplex
        ? "This printer can't print double-sided, which booklets need."
        : exclusive && stapleOn
          ? "A booklet can't also be stapled in a corner. Set staple to None to make a booklet."
          : null,
  };
}

/** Plain wording for a stapled / double-sided choice, used by the live summary. */
export function describeChoices(c: Pick<PrintChoices, "sides" | "staple" | "booklet">): string[] {
  const parts: string[] = [];
  if (c.booklet !== "none") {
    parts.push(c.booklet === "right" ? "booklet, bound on the right" : c.booklet === "left" ? "booklet, bound on the left" : "booklet");
  } else {
    parts.push(c.sides === "two" ? "double-sided" : "single-sided");
    if (c.staple === "top-left") parts.push("stapled top-left");
    if (c.staple === "top-right") parts.push("stapled top-right");
    if (c.staple === "profile") parts.push("stapled");
  }
  return parts;
}

export interface PrintSummary {
  /** Pages that will actually print, after any page range and (for a booklet) blank padding. */
  pages: number;
  blankPagesAdded: number;
  printedSides: number;
  sheets: number;
  /** e.g. "10 pages, 2 copies, double-sided, stapled top-left = 10 sheets" */
  text: string;
}

/**
 * The live summary under the form, from the same print math the server uses. Null until a page count is
 * known. `pages` is the SELECTED page count (the page range is applied before any booklet padding).
 */
export function buildSummary(input: {
  pages: number | null;
  copies: number;
  sides: SidesChoice;
  staple: StapleChoice;
  booklet: BookletChoice;
}): PrintSummary | null {
  const { pages, copies } = input;
  if (!pages || pages < 1 || !Number.isInteger(copies) || copies < 1) return null;
  const isBooklet = input.booklet !== "none";
  const padded = isBooklet ? computeBookletPadding(pages).paddedPages : pages;
  const math = computePrintMath({ pageCount: padded, copies, duplex: isBooklet || input.sides === "two", booklet: isBooklet });
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const text = `${plural(pages, "page", "pages")}, ${plural(copies, "copy", "copies")}, ${describeChoices(input).join(", ")} = ${plural(math.physicalSheets, "sheet", "sheets")}`;
  return { pages: padded, blankPagesAdded: padded - pages, printedSides: math.printedSides, sheets: math.physicalSheets, text };
}
