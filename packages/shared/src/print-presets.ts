/**
 * Print presets selected through the print dialog's PAPER TYPE list (IPP `media-type`).
 *
 * The OS print dialog has no "booklet" option, so the one Printio printer advertises a few extra paper types
 * (`media-type-supported`). When a job arrives with one of these names, the website builds that booklet / layout.
 * Which OS actually draws a paper-type list is UNTESTED; anything absent or unrecognised behaves as before.
 * See docs/ipp-printing.md, "Presets via paper type".
 *
 * Pure data and lookups. `PresetLayout` mirrors packages/pdf `LayoutSpec` structurally (shared must not import
 * @printio/pdf); a type-level test in apps/web proves it stays assignable.
 */

/** Same shape as `LayoutSpec` in packages/pdf/src/nup.ts. */
export type PresetLayout =
  | {
      kind: "nup";
      cols: number;
      rows: number;
      gap?: number;
      margin?: number;
      border?: boolean;
      order?: "row" | "column";
      orientation?: "auto" | "portrait" | "landscape";
    }
  | {
      kind: "repeat";
      cols: number;
      rows: number;
      pages: "each" | "first" | number;
      marks?: boolean;
      border?: boolean;
      gap?: number;
    };

/** What a preset forces. Anything the dialog sent for these is overridden; copies, page range, orientation and paper size stay the dialog's. */
export interface PresetChoices {
  /** "none" = no booklet; "left" / "right" = booklet bound on that edge (a booklet is stapled for you). */
  booklet: "none" | "left" | "right";
  /** Corner staple. Presets always say "none": a booklet is stapled by the booklet itself, a layout is not stapled. Hole punch is always off. */
  staple: "none";
  /** Absent = the dialog's sides (a booklet is always double-sided). */
  sides?: "one" | "two";
}

export interface PrintPreset {
  id: string;
  /** Shown in the dialog's paper type list. Plain, short (under 40 characters). */
  mediaTypeName: string;
  description: string;
  choices: PresetChoices;
  layout?: PresetLayout;
}

export const PRINT_PRESETS: readonly PrintPreset[] = [
  {
    id: "booklet-right-stapled",
    mediaTypeName: "Booklet - right edge, stapled",
    description: "Folded booklet bound on the right edge, stapled in the middle.",
    choices: { booklet: "right", staple: "none", sides: "two" },
  },
  {
    id: "booklet-left-stapled",
    mediaTypeName: "Booklet - left edge, stapled",
    description: "Folded booklet bound on the left edge, stapled in the middle.",
    choices: { booklet: "left", staple: "none", sides: "two" },
  },
  {
    id: "2-up",
    mediaTypeName: "2 pages per sheet",
    description: "Two pages side by side on each sheet.",
    choices: { booklet: "none", staple: "none" },
    layout: { kind: "nup", cols: 2, rows: 1 },
  },
  {
    id: "4-up",
    mediaTypeName: "4 pages per sheet",
    description: "Four pages on each sheet.",
    choices: { booklet: "none", staple: "none" },
    layout: { kind: "nup", cols: 2, rows: 2 },
  },
  {
    id: "repeat-2-cut",
    mediaTypeName: "Same page twice per sheet (cut in half)",
    description: "Every page printed twice side by side on a sheet, with cut marks.",
    choices: { booklet: "none", staple: "none" },
    layout: { kind: "repeat", cols: 2, rows: 1, pages: "each", marks: true },
  },
];

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const BY_NAME = new Map(PRINT_PRESETS.map((p) => [norm(p.mediaTypeName), p]));

/** The preset for a dialog paper type (case-insensitive, trimmed), or null. */
export function presetForMediaType(name: unknown): PrintPreset | null {
  if (typeof name !== "string") return null;
  return BY_NAME.get(norm(name)) ?? null;
}

/** The names to advertise as `media-type-supported` (after the standard default). */
export function presetMediaTypeNames(): string[] {
  return PRINT_PRESETS.map((p) => p.mediaTypeName);
}

/**
 * Standard IPP / PWG 5101.1 media-type keywords a client may send. They mean "no preset" (print as today).
 * Anything else that is not a preset name is a custom name (for example a renamed preset a phone still remembers).
 */
export const STANDARD_MEDIA_TYPES: readonly string[] = [
  "stationery", "stationery-coated", "stationery-inkjet", "stationery-letterhead", "stationery-lightweight", "stationery-heavyweight",
  "stationery-preprinted", "stationery-prepunched", "bond", "letterhead", "cardstock", "cardboard", "envelope", "envelope-plain",
  "envelope-window", "labels", "labels-colored", "labels-glossy", "labels-high-gloss", "labels-inkjet", "labels-matte", "labels-permanent",
  "labels-satin", "labels-security", "labels-waterproof", "transparency", "photographic", "photographic-archival", "photographic-film",
  "photographic-glossy", "photographic-high-gloss", "photographic-matte", "photographic-satin", "photographic-semi-gloss", "auto",
  "aluminum", "back-print-film", "cd", "continuous", "continuous-long", "continuous-short", "cover", "disc", "disc-glossy", "disc-high-gloss",
  "disc-matte", "disc-satin", "disc-semi-gloss", "double-wall", "full-cut-tabs", "heavyweight", "light", "multi-layer", "multi-part-form",
  "other", "paper", "pre-cut-tabs", "roll", "screen", "screen-paged", "self-adhesive", "self-adhesive-film", "shrink-foil", "single-face",
  "single-wall", "sleeve", "tab-stock", "tractor", "wet-film",
];
const STANDARD_SET = new Set(STANDARD_MEDIA_TYPES);

/** True for a standard IPP media-type keyword (case-insensitive, trimmed). */
export function isStandardMediaType(name: unknown): boolean {
  return typeof name === "string" && STANDARD_SET.has(norm(name));
}
