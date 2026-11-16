/**
 * "Print again": turn a finished job row into (a) the choices the print page's form should be filled with, (b) the
 * banner text, and (c) the same choices in the shape the submit pipeline takes (what reprintJobAction re-runs).
 * Pure and unit-tested (print-again.test.ts); the page and the server action only do the reading and the wiring.
 *
 * Access: only the person who sent the job, inside the organization it belongs to, may use it - the same rule as
 * reprintJobAction. The file's existence reuses jobFilePath from file-access.ts (purged, or no stored path = gone).
 */
import type { BookletChoice, PrintChoices, SidesChoice, StapleChoice } from "@/lib/print-choices";
import { liveSummaryLine } from "@/lib/print-form-summary";
import { canViewJobFile, jobFilePath } from "@/lib/jobs/file-access";

export const PRINT_AGAIN_PURGED_MESSAGE = "The file was removed after a few days, upload it again.";
export const PRINT_AGAIN_NOT_FOUND_MESSAGE = "That job was not found.";

/** The columns of print_jobs this needs (a `select("*")` row satisfies it). */
export interface PrintAgainJob {
  id: string;
  organization_id: string;
  created_by: string;
  original_file_name: string;
  original_file_path: string | null;
  derived_file_path?: string | null;
  files_purged_at: string | null;
  source_pdf_pages: number;
  copies: number;
  duplex: boolean;
  color_mode: string;
  paper_size: string;
  finishing: unknown;
  staple_position: string | null;
  booklet_binding_side: string | null;
  page_range: string | null;
  printer_profile_id: string | null;
}

export interface JobFinishing {
  staple: boolean;
  booklet: boolean;
  punch: boolean;
  stapleStyle?: "dual-left";
  bookletFit: "fill" | "keep";
  bookletSheet: "letter" | "tabloid";
  duplexEdge?: "short";
  /** Absent = plain paper (every older job). */
  paperType?: "cardstock";
}

/** print_jobs.finishing is JSON written by createPrintJob; read it defensively (older rows lack the newer keys). */
export function readFinishing(value: unknown): JobFinishing {
  const f = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    staple: f.staple === true,
    booklet: f.booklet === true,
    punch: f.punch === true,
    ...(f.stapleStyle === "dual-left" ? { stapleStyle: "dual-left" as const } : {}),
    bookletFit: f.bookletFit === "keep" ? "keep" : "fill",
    bookletSheet: f.bookletSheet === "tabloid" ? "tabloid" : "letter",
    ...(f.duplexEdge === "short" ? { duplexEdge: "short" as const } : {}),
    ...(f.paperType === "cardstock" ? { paperType: "cardstock" as const } : {}),
  };
}

/** "tabloid" is how a stored job spells 11x17; the pipeline (and a raw printer) asks for "11x17". */
export function paperSizeForPipeline(stored: string): string {
  return stored === "tabloid" ? "11x17" : stored;
}

/** The size to select in the form's list: what the printer declares, else the other spelling of 11x17. */
export function paperSizeForForm(stored: string, declared: readonly string[]): string {
  if (declared.includes(stored)) return stored;
  if (stored === "tabloid" && declared.includes("11x17")) return "11x17";
  return stored;
}

/**
 * Everything a job used, in the shape the submit pipeline takes. "profile" (staple / booklet) means an older job
 * that never stored a corner or binding side: use the printer's own default. Includes the short-edge flip, the
 * staple corner / two-staple style, and the booklet side / fit / sheet, so a re-created job carries all of it.
 */
export function pipelineSettingsFromJob(job: PrintAgainJob): {
  choices: PrintChoices;
  colorMode: "bw" | "color";
  paperSize: string;
  punch: boolean;
  bookletFit: "fill" | "keep";
  bookletSheet: "letter" | "tabloid";
} {
  const f = readFinishing(job.finishing);
  const staple: StapleChoice = !f.staple
    ? "none"
    : f.stapleStyle === "dual-left"
      ? "dual-left"
      : job.staple_position === "top-left" || job.staple_position === "top-right"
        ? job.staple_position
        : "profile";
  const booklet: BookletChoice = !f.booklet ? "none" : job.booklet_binding_side === "left" || job.booklet_binding_side === "right" ? job.booklet_binding_side : "profile";
  const choices: PrintChoices = {
    sides: job.duplex ? "two" : "one",
    staple,
    booklet,
    copies: job.copies,
    ...(f.punch ? { punch: true } : {}),
    ...(f.duplexEdge === "short" && job.duplex && !f.booklet ? { flip: "short" as const } : {}),
    ...(f.paperType === "cardstock" && !f.booklet ? { paper: "cardstock" as const } : {}),
    pageRange: job.page_range ?? "",
  };
  return {
    choices,
    colorMode: job.color_mode === "color" ? "color" : "bw",
    paperSize: paperSizeForPipeline(job.paper_size),
    punch: f.punch,
    bookletFit: f.bookletFit,
    bookletSheet: f.bookletSheet,
  };
}

/** What the print page's form starts with. Plain serializable values (it is handed from the server page to the client form). */
export interface PrintAgainFormChoices {
  profileId: string | null;
  sides: SidesChoice;
  flip: "short" | null;
  /** "cardstock" when the earlier job asked for it; "plain" for every older job. */
  paper: "plain" | "cardstock";
  staple: Exclude<StapleChoice, "profile">;
  booklet: Exclude<BookletChoice, "profile">;
  copies: number;
  punch: boolean;
  pageRange: string;
  colorMode: "bw" | "color";
  paperSize: string;
  bookletFit: "fill" | "keep";
  bookletSheet: "letter" | "tabloid";
}

/** Job row -> the form's choices. A job from before corners / binding sides were stored gets the usual top-left / left. */
export function formChoicesFromJob(job: PrintAgainJob): PrintAgainFormChoices {
  const s = pipelineSettingsFromJob(job);
  const c = s.choices;
  return {
    profileId: job.printer_profile_id,
    sides: c.booklet !== "none" ? "two" : c.sides,
    flip: c.flip ?? null,
    paper: c.paper === "cardstock" ? "cardstock" : "plain",
    staple: c.staple === "profile" ? "top-left" : c.staple,
    booklet: c.booklet === "profile" ? "left" : c.booklet,
    copies: c.copies,
    punch: s.punch,
    pageRange: c.pageRange,
    colorMode: s.colorMode,
    paperSize: job.paper_size,
    bookletFit: s.bookletFit,
    bookletSheet: s.bookletSheet,
  };
}

/** "6 pages · 2 copies · double-sided · stapled top-left, pages 1-5, 8, ..." - plain words, built from the existing summary helpers. */
export function printAgainSummary(job: PrintAgainJob): string {
  const c = formChoicesFromJob(job);
  const line = liveSummaryLine({
    pages: job.source_pdf_pages,
    copies: c.copies,
    sides: c.sides,
    staple: c.staple,
    booklet: c.booklet,
    punch: c.punch && c.booklet === "none",
  });
  const parts = [c.staple === "top-left" || c.staple === "top-right" ? line.replace("stapled", `stapled ${c.staple}`) : line];
  if (c.booklet !== "none") {
    parts.push(`bound on the ${c.booklet}`);
    if (c.bookletSheet === "tabloid") parts.push("11x17 sheet");
    else if (c.bookletFit === "keep") parts.push("original margins kept");
  } else if (c.flip === "short") {
    parts.push("flips on the short edge");
  }
  if (c.pageRange.trim()) parts.push(`only pages ${c.pageRange.trim()}`);
  if (c.paper === "cardstock") parts.push("cardstock (bypass tray)");
  if (c.colorMode === "color") parts.push("color");
  if (c.paperSize !== "letter") parts.push(c.paperSize === "tabloid" ? "11x17 paper" : `${c.paperSize} paper`);
  return parts.join(" · ");
}

/** The banner at the top of the print page. */
export function printAgainBanner(job: PrintAgainJob): string {
  return `Printing again: ${job.original_file_name}. Same settings as last time (${printAgainSummary(job)}). Change anything below.`;
}

export type PrintAgainResult =
  | {
      kind: "ok";
      jobId: string;
      fileName: string;
      /** Storage path of the original, read off the verified row (never from the request). */
      filePath: string;
      banner: string;
      choices: PrintAgainFormChoices;
    }
  | { kind: "purged"; message: string }
  | { kind: "not_found"; message: string };

/**
 * Decides what the print page shows for ?again=<jobId>. `job` is the row as read through the viewer's own session
 * (null when row-level security or the owner filter hid it). Never throws: every failure is a plain message and the
 * page falls back to the normal empty print form.
 */
export function resolvePrintAgain(
  job: PrintAgainJob | null | undefined,
  viewer: { userId: string; role: string | null; organizationId: string | null },
): PrintAgainResult {
  if (!job || !canViewJobFile(viewer, job) || job.created_by !== viewer.userId) {
    return { kind: "not_found", message: PRINT_AGAIN_NOT_FOUND_MESSAGE };
  }
  const path = jobFilePath({ original_file_path: job.original_file_path, derived_file_path: job.derived_file_path ?? null, files_purged_at: job.files_purged_at }, "original");
  if (!path) return { kind: "purged", message: PRINT_AGAIN_PURGED_MESSAGE };
  return { kind: "ok", jobId: job.id, fileName: job.original_file_name, filePath: path, banner: printAgainBanner(job), choices: formChoicesFromJob(job) };
}
