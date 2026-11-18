import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
import { analyzePdfContent } from "./content-analysis";
import { scanPdf } from "./test-scan";

describe("analyzePdfContent on scans (one full-page image per page)", () => {
  it("finds where the ink really is, not the image's whole rectangle", async () => {
    // A Letter scan whose ink sits in the top-right: x from 50% to 90%, y (from the top) from 8% to 40%.
    const bytes = await scanPdf([{ width: 612, height: 792, ink: { x0: 0.5, y0: 0.08, x1: 0.9, y1: 0.4 } }]);
    const [c] = (await analyzePdfContent(bytes))!;
    if (c?.kind !== "content") throw new Error(`expected content, got ${c?.kind}`);
    expect(c.scan).toBe(true);
    // PDF coordinates have y up: the ink's bottom is 40% from the top = 60% of the height up.
    const tol = 14; // a few pixels at ~100 dpi plus the safety padding
    expect(c.box.x0).toBeGreaterThanOrEqual(0.5 * 612 - tol);
    expect(c.box.x0).toBeLessThanOrEqual(0.5 * 612 + 1); // never inside the ink: nothing may be cut
    expect(c.box.x1).toBeGreaterThanOrEqual(0.9 * 612 - 1);
    expect(c.box.x1).toBeLessThanOrEqual(0.9 * 612 + tol);
    expect(c.box.y1).toBeGreaterThanOrEqual(792 * (1 - 0.08) - 1);
    expect(c.box.y1).toBeLessThanOrEqual(792 * (1 - 0.08) + tol);
    expect(c.box.y0).toBeGreaterThanOrEqual(792 * (1 - 0.4) - tol);
    expect(c.box.y0).toBeLessThanOrEqual(792 * (1 - 0.4) + 1);
  });

  it("a blank white scan is blank", async () => {
    const [c] = (await analyzePdfContent(await scanPdf([{ width: 612, height: 792, ink: null }])))!;
    expect(c?.kind).toBe("blank");
  });

  it("works for every page size in one document", async () => {
    const bytes = await scanPdf([
      { width: 612, height: 792, ink: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 } },
      { width: 842, height: 595, ink: { x0: 0.3, y0: 0.2, x1: 0.6, y1: 0.7 } },
    ]);
    const res = (await analyzePdfContent(bytes))!;
    expect(res).toHaveLength(2);
    for (const c of res) expect(c.kind).toBe("content");
    const land = res[1]!;
    if (land.kind !== "content") throw new Error("x");
    expect(land.box.x0).toBeGreaterThan(0.25 * 842); // clearly tighter than the whole page
    expect(land.box.x1).toBeLessThan(0.7 * 842);
  });
});
