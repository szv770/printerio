/**
 * Invokes SumatraPDF to submit a job to a (pre-configured) Windows print
 * queue. See docs/architecture.md sec 9-10.
 *
 * CONSTRAINT (non-negotiable): this module never reads `finishing`
 * (staple/booklet/punch) off the resolved print request to build a
 * SumatraPDF flag or any raw PJL/PRESCRIBE stream. Finishing is entirely a
 * property of *which queue* was chosen (windowsQueueName, resolved by the
 * cloud) - see docs/architecture.md sec 9 and docs/printer-setup.md. The
 * `ResolvedPrintRequest.finishing` field exists for the cloud/UI, not for
 * this module; it is intentionally unused here.
 *
 * The `-print-settings` value is built ONLY from the allow-listed token
 * vocabulary documented in docs/architecture.md sec 10, and every token is
 * validated against an explicit pattern before being included - even though
 * this is a single argv element (not a shell string), so there is no
 * unvalidated pass-through of any field (in particular `paperSize`, which
 * originates from the cloud) into the settings string.
 */

import { spawn } from "node:child_process";
import type { ColorMode } from "@printos/shared";
import type { Logger } from "./logger.js";
import type { PrintFitMode } from "./config.js";
import { PrintExecutionError } from "./errors.js";

// --- Allow-listed token vocabulary (docs/architecture.md sec 10) ---
const TOKEN_PATTERNS: RegExp[] = [
  /^\d+(-\d+)?(,\d+(-\d+)?)*$/, // page range, e.g. "1-3,5"
  /^(color|monochrome)$/,
  /^(duplex|duplexshort|duplexlong|simplex)$/,
  /^(fit|shrink|noscale)$/,
  /^collate$/,
  /^paper=[A-Za-z0-9_.-]{1,64}$/,
  /^bin=[A-Za-z0-9_.-]{1,64}$/,
  /^[1-9][0-9]{0,2}x$/, // copies, e.g. "4x" - Sumatra's "N copies" token
];

function isAllowListedToken(token: string): boolean {
  return TOKEN_PATTERNS.some((re) => re.test(token));
}

export interface PrintSettingsInput {
  colorMode: ColorMode;
  duplex: boolean;
  paperSize: string;
  copies: number;
  /** Optional page-range subset - not currently part of ResolvedPrintRequest (which always prints the whole document), exposed here for forward-compatibility with the allow-listed vocabulary. */
  pageRange?: string;
  fitMode: PrintFitMode;
  collateMultiCopy: boolean;
}

/**
 * Builds the ordered list of `-print-settings` tokens for a job. Every
 * returned token has already passed the allow-list; this function throws
 * `PrintExecutionError` (never silently drops or "best-effort passes
 * through") if something it constructed itself somehow fails validation -
 * that should only happen if `paperSize` contains characters outside
 * `[A-Za-z0-9_.-]`, which is treated as a configuration problem to fix at
 * the printer-profile level, not a value to smuggle through.
 */
export function buildPrintSettingsTokens(input: PrintSettingsInput): string[] {
  const tokens: string[] = [];

  if (input.pageRange) tokens.push(input.pageRange);
  tokens.push(input.colorMode === "color" ? "color" : "monochrome");
  tokens.push(input.duplex ? "duplex" : "simplex");
  tokens.push(input.fitMode);

  if (!Number.isInteger(input.copies) || input.copies < 1 || input.copies > 999) {
    throw new PrintExecutionError(`copies out of allowed range (1-999): ${input.copies}`);
  }
  if (input.copies > 1) {
    tokens.push(`${input.copies}x`);
    if (input.collateMultiCopy) tokens.push("collate");
  }

  if (input.paperSize) {
    tokens.push(`paper=${input.paperSize}`);
  }

  for (const token of tokens) {
    if (!isAllowListedToken(token)) {
      throw new PrintExecutionError(`refusing to emit a non-allow-listed print-settings token: ${token}`);
    }
  }
  return tokens;
}

export function buildPrintSettingsString(input: PrintSettingsInput): string {
  return buildPrintSettingsTokens(input).join(",");
}

export interface SumatraInvocation {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ExecutePrintOptions {
  sumatraPath: string;
  windowsQueueName: string;
  pdfPath: string;
  settingsString: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Invokes SumatraPDF with an argv array - queue name, settings string, and
 * pdf path are all passed as separate argv entries, never concatenated into
 * a shell string (docs/architecture.md sec 10).
 *
 * A successful (exit 0) process means only "the spooler accepted the job" -
 * see spooler-monitor.ts for what happens after that, and
 * docs/known-limitations.md for why exit 0 is not proof of physical
 * completion.
 */
export function executePrint(options: ExecutePrintOptions, logger: Logger): Promise<SumatraInvocation> {
  if (!options.windowsQueueName || !options.windowsQueueName.trim()) {
    return Promise.reject(new PrintExecutionError("windowsQueueName is required"));
  }
  if (!options.pdfPath) {
    return Promise.reject(new PrintExecutionError("pdfPath is required"));
  }

  const args = [
    "-print-to",
    options.windowsQueueName,
    "-print-settings",
    options.settingsString,
    "-silent",
    options.pdfPath,
  ];

  logger.info("invoking SumatraPDF", {
    sumatraPath: options.sumatraPath,
    windowsQueueName: options.windowsQueueName,
    settingsString: options.settingsString,
    // pdfPath is a local temp path, not document content - safe to log.
    pdfPath: options.pdfPath,
  });

  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(options.sumatraPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(new PrintExecutionError("failed to spawn SumatraPDF", { cause: String(err) }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new PrintExecutionError("SumatraPDF process error (is it installed / on PATH?)", { cause: String(err) }));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (timedOut) {
        reject(
          new PrintExecutionError(`SumatraPDF timed out after ${timeoutMs}ms`, {
            stdout: stdout.slice(0, 2000),
            stderr: stderr.slice(0, 2000),
          }),
        );
        return;
      }
      resolve({ exitCode: code, stdout, stderr, durationMs });
    });
  });
}
