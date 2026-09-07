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
   * `PRINTIO_PRINT_FIT_MODE` default. Absent for the vast majority of jobs,
   * whose fit mode is entirely an Agent-machine-level setting (see
   * apps/agent/src/config.ts) - the cloud has no opinion. Set ONLY for a
   * booklet job, forced to `"noscale"`: Printio has already imposed and
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
  "CHECK_FOR_UPDATE",
] as const;

export type RemoteCommand = (typeof REMOTE_COMMANDS)[number];

export interface RemoteCommandPayload {
  CANCEL_PRINT_JOB: { jobId: string };
  RESTART_PRINT_QUEUE: { printerProfileId: string };
  REFRESH_PRINTER_STATUS: Record<string, never>;
  RESTART_AGENT_SERVICE: Record<string, never>;
  CLEAR_AGENT_TEMP_FILES: Record<string, never>;
  /** Deliberately payload-free: the Agent runs one hardcoded update sequence
   *  in its own checkout (apps/agent/src/self-update.ts) and takes no branch,
   *  remote, path, or command string from the cloud. */
  CHECK_FOR_UPDATE: Record<string, never>;
}

/**
 * The Agent version this repository currently ships - the compare-target the
 * admin console shows next to whatever version an Agent actually reported
 * (`agents.version`), so "this machine is on 0.1.0, latest is 0.2.0" is
 * answerable instead of just showing a bare version string with nothing to
 * compare it to.
 *
 * It lives here, not in apps/agent/package.json, because apps/web cannot
 * import from apps/agent (two independent deployables - docs/architecture.md
 * sec 1) while both already depend on this package. Bump it in the same
 * commit that bumps apps/agent/package.json's "version":
 * apps/agent/test/version.test.ts fails the build if the two ever drift, so
 * this cannot silently go stale.
 */
export const LATEST_AGENT_VERSION = "0.1.0";

/**
 * Compares two dot-separated version strings numerically (not
 * lexicographically - "0.10.0" is newer than "0.9.0", which a string compare
 * gets backwards). Missing/unparseable segments count as 0, and a null/empty
 * reported version yields "unknown" rather than a guess.
 *
 * Pure and dependency-free specifically so both the web app and the Agent's
 * tests can use the same implementation.
 */
export function compareAgentVersions(
  reported: string | null | undefined,
  latest: string,
): "unknown" | "up_to_date" | "outdated" | "ahead" {
  if (!reported || !reported.trim()) return "unknown";
  const parse = (v: string) => v.trim().split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(reported);
  const b = parse(latest);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return "outdated";
    if (x > y) return "ahead";
  }
  return "up_to_date";
}

/** print_job_events.metadata shapes worth typing; unlisted event types carry Record<string, unknown>. */
export interface BookletPaddingMetadata {
  type: "booklet_padding";
  pagesAdded: number;
  paddedPages: number;
}
