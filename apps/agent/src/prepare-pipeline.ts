/**
 * The PDF pipeline for the prepare worker (docs/PREPARE-JOBS-DESIGN.md, P2b step 5): the same `preparePdf` the website used to run itself, now on the
 * school's own print server. It turns a claimed job's params and the downloaded original into the wire result the website finishes the job from.
 *
 * `@printio/pdf` (pdf-lib, pdf.js) is loaded the first time a job arrives, never at start-up, so a print server that has the worker off - or has not
 * been asked to prepare anything yet - pays nothing for it. The pdf.js bundled with it needs Node 22.13+; `nodeCanPrepare` says whether this machine can.
 */
import type { PrepareJobParams } from "@printio/pdf/prepare-wire";
import type { Logger } from "./logger.js";
import type { PreparePipeline } from "./prepare-worker.js";

/** pdf.js 6 needs Node 22.13 or newer (the update check in self-update.ts enforces the repo's engines the same way). */
export function nodeCanPrepare(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map((n) => Number.parseInt(n, 10));
  return major > 22 || (major === 22 && minor >= 13);
}

export function isPrepareParams(value: unknown): value is PrepareJobParams {
  if (!value || typeof value !== "object") return false;
  const v = value as { v?: unknown; pdf?: unknown; finish?: unknown };
  if (v.v !== 1 || !v.pdf || typeof v.pdf !== "object") return false;
  const pdf = v.pdf as Record<string, unknown>;
  return (
    typeof pdf.maxUploadBytes === "number" &&
    (pdf.colorMode === "bw" || pdf.colorMode === "color") &&
    typeof pdf.booklet === "boolean" &&
    typeof pdf.confirmBookletPadding === "boolean" &&
    !!pdf.bookletOptions &&
    typeof pdf.bookletOptions === "object"
  );
}

export function createPdfPipeline(logger: Logger): PreparePipeline {
  return async ({ original, params, signal }) => {
    if (!isPrepareParams(params)) {
      // A newer website than this print server understands: say so plainly instead of guessing.
      return { kind: "rejected", reason: "This print server is out of date and cannot prepare this file yet. Ask your admin to press Update on the server." };
    }
    const [{ preparePdf }, { prepareInputFromParams, toWire }] = await Promise.all([import("@printio/pdf/prepare"), import("@printio/pdf/prepare-wire")]);
    if (signal.aborted) throw new Error("aborted");
    const result = await preparePdf({
      ...prepareInputFromParams(params),
      originalBytes: original,
      logger: {
        warn: (message, fields) => logger.warn(message, fields),
        error: (message, fields) => logger.error(message, fields),
      },
    });
    if (signal.aborted) throw new Error("aborted");
    const { preparedPath: _unused, ...wire } = toWire(result, null);
    void _unused;
    // ok + derivedBytes: upload the prepared file; ok without bytes (held, or the original prints as it is) and every error/question: nothing to upload.
    return { kind: "prepared", bytes: result.ok ? result.derivedBytes : null, result: wire };
  };
}
