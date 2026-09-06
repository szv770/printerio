/**
 * Shared DB-aligned types. Kept in sync by hand with supabase/migrations - for
 * the full generated types (all columns), see apps/web/lib/database.types.ts
 * (generated via `supabase gen types typescript`). These are the subset both
 * apps/web and apps/agent need a stable shared shape for.
 */

import type { JobState } from "./job-state";
import type { OrgRole, PolicyAction } from "./policy-engine";

export type { OrgRole, PolicyAction, JobState };

export type QuotaBasis = "pdf_pages" | "printed_sides" | "physical_sheets" | "color_weighted";

export type ColorMode = "bw" | "color";

/** Mirrors apps/agent/src/config.ts's `PrintFitMode` (kept in sync by hand -
 * this package cannot import from apps/agent, see file header). */
export type PrintFitMode = "fit" | "shrink" | "noscale";

export interface FinishingOptions {
  staple: boolean;
  booklet: boolean;
  punch: boolean;
}

export interface DeclaredCapabilities {
  duplex: boolean;
  color: boolean;
  staple: boolean;
  booklet: boolean;
  punch: boolean;
}

/**
 * The logical print request an approved job resolves to. The Agent receives
 * exactly this shape (never a raw Windows queue name from an untrusted
 * client) - see docs/architecture.md sec 9-10.
 */
export interface ResolvedPrintRequest {
  jobId: string;
  printerProfileId: string;
  /** Resolved server/agent-side only; never sent to the browser. */
  windowsQueueName: string;
  pageCount: number;
  copies: number;
  colorMode: ColorMode;
  duplex: boolean;
  paperSize: string;
  finishing: FinishingOptions;
  /**
   * Optional per-job override of the Agent's own configured
   * `PRINTOS_PRINT_FIT_MODE` default. Absent for the vast majority of jobs,
   * whose fit mode is entirely an Agent-machine-level setting (see
   * apps/agent/src/config.ts) - the cloud has no opinion. Set ONLY for a
   * booklet job, forced to `"noscale"`: PrintOS has already imposed and
   * independently scaled every page to its exact target sheet size
   * (apps/web/lib/pdf/imposition.ts), so asking the driver to `fit`/`shrink`
   * further would silently re-scale an already-correctly-sized page and
   * undo that work. See docs/architecture.md sec 8-10.
   */
  fitMode?: PrintFitMode;
}

/** The fixed, allow-listed remote command set - see docs/architecture.md sec 12. */
export const REMOTE_COMMANDS = [
  "REFRESH_PRINTER_STATUS",
  "CANCEL_PRINT_JOB",
  "RESTART_PRINT_QUEUE",
  "RESTART_AGENT_SERVICE",
  "CLEAR_AGENT_TEMP_FILES",
] as const;

export type RemoteCommand = (typeof REMOTE_COMMANDS)[number];

export interface RemoteCommandPayload {
  CANCEL_PRINT_JOB: { jobId: string };
  RESTART_PRINT_QUEUE: { printerProfileId: string };
  REFRESH_PRINTER_STATUS: Record<string, never>;
  RESTART_AGENT_SERVICE: Record<string, never>;
  CLEAR_AGENT_TEMP_FILES: Record<string, never>;
}

/** print_job_events.metadata shapes worth typing; unlisted event types carry Record<string, unknown>. */
export interface BookletPaddingMetadata {
  type: "booklet_padding";
  pagesAdded: number;
  paddedPages: number;
}
