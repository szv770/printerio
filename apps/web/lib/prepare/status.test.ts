import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { viewFromRow } from "./status";

const params = { finish: { originalFileName: "Test.pdf" } };
const row = (status: string, result: unknown = null) => ({ status, params, result });

describe("viewFromRow", () => {
  it("waiting or being prepared shows preparing, with the print server state", () => {
    expect(viewFromRow(row("queued"), false)).toMatchObject({ state: "preparing", serverOnline: false, fileName: "Test.pdf" });
    expect(viewFromRow(row("claimed"), true)).toMatchObject({ state: "preparing", serverOnline: true });
  });
  it("a job the website has not finished yet still shows preparing (the retry finishes it)", () => {
    expect(viewFromRow(row("done", { preparedPath: "x" }), true).state).toBe("preparing");
  });
  it("done with a print job points to it", () => {
    expect(viewFromRow(row("done", { printJobId: "j1" }), true)).toEqual({ state: "done", fileName: "Test.pdf", printJobId: "j1" });
  });
  it("a booklet question is offered, not an error", () => {
    const needs = { sourcePages: 5, paddedPages: 8, blankPagesAdded: 3 };
    expect(viewFromRow(row("done", { needsBookletConfirm: needs }), true)).toMatchObject({ state: "needs_booklet_confirm", needsBookletConfirm: needs });
  });
  it("errors become plain reasons, with the page range message kept", () => {
    expect(viewFromRow(row("done", { error: { code: "invalid_page_range", message: "Bad range.", fieldErrors: { pageRange: "Use 1-3." } } }), true)).toEqual({
      state: "failed", fileName: "Test.pdf", message: "Bad range.", fieldError: "Use 1-3.",
    });
    expect(viewFromRow(row("done", { rejectedReason: "Password protected." }), true)).toMatchObject({ state: "failed", message: "Password protected." });
    expect(viewFromRow(row("failed", { error: "expired" }), true)).toMatchObject({ state: "failed", message: expect.stringContaining("not available for too long") });
    expect(viewFromRow(row("failed"), true)).toMatchObject({ state: "failed", message: expect.stringContaining("Something went wrong") });
  });
  it("cancelled wins over everything", () => {
    expect(viewFromRow(row("cancelled", { printJobId: "j1" }), true).state).toBe("cancelled");
  });
});
