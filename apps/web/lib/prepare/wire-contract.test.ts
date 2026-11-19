import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { toWire } from "@printio/pdf/prepare-wire";
import type { PreparePdfResult } from "@printio/pdf/prepare";
import { prepareResultSchema } from "./prepare-jobs";

// Whatever the print server's pipeline sends (toWire of each possible preparePdf answer), the website's strict schema must accept it.
const ok: PreparePdfResult = { ok: true, held: false, heldReason: null, derivedBytes: null, effectivePageCount: 8, blankPagesAdded: 3, sourcePages: 5, pageRangeText: "1-5", fileSizeBytes: 12345, pictureCopy: false };
const answers: [string, PreparePdfResult][] = [
  ["prepared", ok],
  ["held", { ...ok, held: true, heldReason: "Needs approval", pageRangeText: null }],
  ["picture copy", { ...ok, pictureCopy: true }],
  ["bad pdf", { ok: false, kind: "error", code: "bad_pdf", error: "Not a PDF." }],
  ["bad range", { ok: false, kind: "error", code: "invalid_page_range", error: "Bad range.", fieldErrors: { pageRange: "Use 1-3." } }],
  ["booklet question", { ok: false, kind: "needs_booklet_confirm", needsBookletConfirm: { sourcePages: 5, paddedPages: 8, blankPagesAdded: 3 } }],
];

describe("the print server's result is accepted by the website's schema", () => {
  for (const [name, answer] of answers) {
    it(name, () => {
      const { preparedPath: _p, ...withoutPath } = toWire(answer, null);
      void _p;
      expect(prepareResultSchema.safeParse({ ...withoutPath, preparedPath: null }).success).toBe(true);
      expect(prepareResultSchema.safeParse({ ...withoutPath, preparedPath: "prepared/org/job/x.pdf" }).success).toBe(true);
    });
  }
});
