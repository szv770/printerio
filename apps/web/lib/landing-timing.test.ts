import { describe, expect, it } from "vitest";
import { FOLD_MS, PHASE_AT_MS, STAPLE_HIT_FRACTION, STAPLE_STROKE_MS, STITCH_AT_MS, STITCH_POP_MS, finishMs, stapleHitMs, totalMs } from "./landing-timing";

describe("home page demo timing (shared by the animation and the sound)", () => {
  it("phases run in order", () => {
    const t = PHASE_AT_MS;
    expect(t.sending).toBeLessThan(t.checking);
    expect(t.checking).toBeLessThan(t.printing);
    expect(t.printing).toBeLessThan(t.delivered);
  });

  it("the stapler hits the page at 40% of its stroke, which is where the CSS keyframes put the hit", () => {
    expect(STAPLE_HIT_FRACTION).toBe(0.4);
    expect(stapleHitMs()).toBe(Math.round(STAPLE_STROKE_MS * 0.4));
    expect(stapleHitMs()).toBeGreaterThan(0);
    expect(stapleHitMs()).toBeLessThan(STAPLE_STROKE_MS);
  });

  it("stitches go in after the fold has started closing, one after the other, each finishing before the end", () => {
    expect(STITCH_AT_MS[0]).toBeGreaterThan(FOLD_MS * 0.9);
    expect(STITCH_AT_MS[1]).toBeGreaterThan(STITCH_AT_MS[0]);
    expect(finishMs("booklet")).toBeGreaterThanOrEqual(STITCH_AT_MS[1] + STITCH_POP_MS);
  });

  it("no finish means no finishing time, and totals include the print time", () => {
    expect(finishMs("none")).toBe(0);
    expect(totalMs("none")).toBe(PHASE_AT_MS.delivered);
    expect(totalMs("staple")).toBe(PHASE_AT_MS.delivered + finishMs("staple"));
    expect(finishMs("staple")).toBeGreaterThanOrEqual(STAPLE_STROKE_MS);
  });
});
