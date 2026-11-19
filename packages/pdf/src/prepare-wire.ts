import type { BookletFit } from "./imposition";
import type { BookletSheet } from "./booklet-build";
import type { PreparePdfErrorCode, PreparePdfInput, PreparePdfResult, StampPlan } from "./prepare";

/**
 * What travels between the website and a print server for a prepare job (docs/PREPARE-JOBS-DESIGN.md). Plain JSON, no functions:
 *  - `PrepareJobParams` goes DOWN (stored on the job, claimed by the print server): everything `preparePdf` needs plus what the website needs
 *    later to finish the job.
 *  - `PrepareWire` comes back UP (the `complete` call): the outcome of `preparePdf`, with the prepared file named by its storage path.
 * Pure functions only, so the website, the print server and the tests all use the same definition.
 */

/** The member's choices and the booklet options that the website's finish step needs again. Mirrors the plain fields of the website's JobOptions. */
export interface PrepareJobOptions {
  printerProfileId: string;
  choices: Record<string, unknown>;
  colorMode: "bw" | "color";
  paperSize: string;
  punch: boolean;
  confirmBookletPadding: boolean;
  bookletFit?: BookletFit;
  bookletSheet?: BookletSheet;
  forcedHeldReason?: string;
  source?: "web" | "ipp";
  deviceId?: string;
  ippUserAgent?: string;
}

export interface PrepareJobParams {
  v: 1;
  /** For the print server: the PDF steps. */
  pdf: {
    maxUploadBytes: number;
    colorMode: "bw" | "color";
    heldReason: string | null;
    forcedHeldReason?: string;
    pageRangeText: string | null;
    booklet: boolean;
    bookletOptions: { paperSize: string; bindingSide: "left" | "right"; fit: BookletFit; sheet: BookletSheet };
    confirmBookletPadding: boolean;
    /** Built by the website at intake (it needs the member's code from the database); null = no stamp. */
    stamp: StampPlan | null;
    allowType3Fonts: boolean;
    logContext: Record<string, unknown>;
  };
  /** For the website's finish step. */
  finish: { originalFileName: string; options: PrepareJobOptions };
}

/** The input for `preparePdf` from a claimed job's params (the print server adds the file's bytes and a logger). */
export function prepareInputFromParams(params: PrepareJobParams): Omit<PreparePdfInput, "originalBytes" | "logger"> {
  const p = params.pdf;
  return {
    maxUploadBytes: p.maxUploadBytes,
    colorMode: p.colorMode,
    heldReason: p.heldReason,
    ...(p.forcedHeldReason ? { forcedHeldReason: p.forcedHeldReason } : {}),
    pageRangeText: p.pageRangeText,
    booklet: p.booklet,
    bookletOptions: p.bookletOptions,
    confirmBookletPadding: p.confirmBookletPadding,
    stamp: p.stamp,
    allowType3Fonts: p.allowType3Fonts,
    logContext: p.logContext,
  };
}

/** What a print server reports back (the `result` of `complete`). Exactly one of: a prepared job, an error, or a booklet that needs confirming. */
export interface PrepareWire {
  /** Where the prepared file was uploaded (inside the job's own folder), or null when the original prints as it is. */
  preparedPath: string | null;
  sourcePages: number;
  bookletPaddingAdded?: number;
  flags?: string[];
  fidelity?: "same" | "changed" | "skipped";
  /** Set when the file cannot be printed; the sender sees this plain reason. */
  rejectedReason?: string;
  // The fields the website's finish step needs (present for a successfully prepared job):
  held?: boolean;
  heldReason?: string | null;
  effectivePageCount?: number;
  pageRangeText?: string | null;
  fileSizeBytes?: number;
  pictureCopy?: boolean;
  /** An inline error from the PDF steps (not a PDF, bad page range, ...), with the field it belongs next to. */
  error?: { code: PreparePdfErrorCode; message: string; fieldErrors?: { pageRange?: string } };
  needsBookletConfirm?: { sourcePages: number; paddedPages: number; blankPagesAdded: number };
}

/** The print server's side: turn `preparePdf`'s answer into the wire result (`preparedPath` is where it uploaded the derived file, or null). */
export function toWire(result: PreparePdfResult, preparedPath: string | null): PrepareWire {
  if (!result.ok) {
    if (result.kind === "needs_booklet_confirm") return { preparedPath: null, sourcePages: result.needsBookletConfirm.sourcePages, needsBookletConfirm: result.needsBookletConfirm };
    return { preparedPath: null, sourcePages: 0, error: { code: result.code, message: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) } };
  }
  return {
    preparedPath,
    sourcePages: result.sourcePages,
    bookletPaddingAdded: result.blankPagesAdded,
    held: result.held,
    heldReason: result.heldReason,
    effectivePageCount: result.effectivePageCount,
    pageRangeText: result.pageRangeText,
    fileSizeBytes: result.fileSizeBytes,
    pictureCopy: result.pictureCopy,
  };
}

export type WireOutcome =
  | { kind: "prepared"; prepared: Extract<PreparePdfResult, { ok: true }>; preparedPath: string | null }
  | { kind: "rejected"; reason: string }
  | { kind: "error"; error: NonNullable<PrepareWire["error"]> }
  | { kind: "needs_booklet_confirm"; needsBookletConfirm: NonNullable<PrepareWire["needsBookletConfirm"]> }
  | { kind: "incomplete" };

/** The website's side: what a wire result means. `incomplete` = a result without what the finish step needs (an older print server). */
export function readWire(w: PrepareWire): WireOutcome {
  if (w.rejectedReason) return { kind: "rejected", reason: w.rejectedReason };
  if (w.error) return { kind: "error", error: w.error };
  if (w.needsBookletConfirm) return { kind: "needs_booklet_confirm", needsBookletConfirm: w.needsBookletConfirm };
  if (typeof w.effectivePageCount !== "number" || typeof w.fileSizeBytes !== "number") return { kind: "incomplete" };
  return {
    kind: "prepared",
    preparedPath: w.preparedPath,
    prepared: {
      ok: true,
      held: w.held ?? false,
      heldReason: w.heldReason ?? null,
      // The prepared file is already in storage; the bytes are not needed (the finish step moves the stored file).
      derivedBytes: null,
      effectivePageCount: w.effectivePageCount,
      blankPagesAdded: w.bookletPaddingAdded ?? 0,
      sourcePages: w.sourcePages,
      pageRangeText: w.pageRangeText ?? null,
      fileSizeBytes: w.fileSizeBytes,
      pictureCopy: w.pictureCopy ?? false,
    },
  };
}
