import { describe, it, expect } from "vitest";
import {
  availableSpace,
  pickSide,
  clampAxis,
  clampToViewport,
  computeCalloutPlacement,
  computeArrowOffset,
  padRect,
  buildSpotlightPath,
  type Rect,
} from "./tour-position";

const VIEWPORT = { width: 1200, height: 800 };
const CALLOUT = { width: 280, height: 160 };

function rect(overrides: Partial<Rect>): Rect {
  return { top: 0, left: 0, width: 100, height: 40, ...overrides };
}

describe("availableSpace", () => {
  it("measures the gap-adjusted space on all four sides", () => {
    const target = rect({ top: 300, left: 500, width: 100, height: 40 });
    const space = availableSpace(target, VIEWPORT, 10);
    expect(space.left).toBe(500 - 10);
    expect(space.right).toBe(1200 - 600 - 10);
    expect(space.top).toBe(300 - 10);
    expect(space.bottom).toBe(800 - 340 - 10);
  });
});

describe("pickSide", () => {
  it("prefers the right side when there's room all around", () => {
    const target = rect({ top: 300, left: 500, width: 100, height: 40 });
    expect(pickSide(target, VIEWPORT, CALLOUT, 16)).toBe("right");
  });

  it("falls back to left when the target hugs the right edge", () => {
    const target = rect({ top: 300, left: 1180, width: 20, height: 40 });
    expect(pickSide(target, VIEWPORT, CALLOUT, 16)).toBe("left");
  });

  it("falls back to bottom when neither left nor right fit (target spans full width)", () => {
    const target = rect({ top: 0, left: 0, width: 1200, height: 40 });
    expect(pickSide(target, VIEWPORT, CALLOUT, 16)).toBe("bottom");
  });

  it("falls back to top when the target is at the very bottom and spans full width", () => {
    const target = rect({ top: 760, left: 0, width: 1200, height: 40 });
    expect(pickSide(target, VIEWPORT, CALLOUT, 16)).toBe("top");
  });

  it("when nothing fits at all, picks the side with the most room rather than throwing", () => {
    // A target that fills almost the entire viewport - no side has room for
    // a 280x160 callout, so the "best of a bad set" side wins.
    const target = rect({ top: 10, left: 10, width: 1180, height: 780 });
    const side = pickSide(target, VIEWPORT, CALLOUT, 16);
    expect(["top", "bottom", "left", "right"]).toContain(side);
  });
});

describe("clampAxis / clampToViewport", () => {
  it("leaves an in-bounds position untouched", () => {
    expect(clampAxis(100, 160, 800, 8)).toBe(100);
  });

  it("clamps a negative position up to the margin", () => {
    expect(clampAxis(-50, 160, 800, 8)).toBe(8);
  });

  it("clamps an overflowing position back on-screen", () => {
    // size 160 at viewport 800 with margin 8 -> max top is 800-160-8 = 632
    expect(clampAxis(700, 160, 800, 8)).toBe(632);
  });

  it("never produces a negative max even when size exceeds the viewport", () => {
    // size bigger than the viewport itself - clamped position must still be >= margin, not negative.
    const result = clampAxis(-999, 2000, 800, 8);
    expect(result).toBe(8);
  });

  it("clampToViewport clamps both axes together", () => {
    const result = clampToViewport(-40, 1500, CALLOUT, VIEWPORT, 8);
    expect(result.top).toBeGreaterThanOrEqual(8);
    expect(result.left).toBeLessThanOrEqual(VIEWPORT.width - CALLOUT.width - 8);
  });
});

describe("computeCalloutPlacement", () => {
  it("places the callout to the right of the target, vertically centered on it", () => {
    const target = rect({ top: 300, left: 500, width: 100, height: 40 });
    const placement = computeCalloutPlacement(target, VIEWPORT, CALLOUT, 16);
    expect(placement.side).toBe("right");
    expect(placement.left).toBe(target.left + target.width + 16);
    expect(placement.top).toBeCloseTo(target.top + target.height / 2 - CALLOUT.height / 2);
  });

  it("places the callout above the target when only the top has room", () => {
    const target = rect({ top: 760, left: 0, width: 1200, height: 40 });
    const placement = computeCalloutPlacement(target, VIEWPORT, CALLOUT, 16);
    expect(placement.side).toBe("top");
    expect(placement.top).toBeCloseTo(target.top - 16 - CALLOUT.height);
  });

  it("always keeps the callout fully within the viewport bounds", () => {
    const target = rect({ top: 0, left: 0, width: 20, height: 20 });
    const placement = computeCalloutPlacement(target, VIEWPORT, CALLOUT, 16);
    expect(placement.top).toBeGreaterThanOrEqual(0);
    expect(placement.left).toBeGreaterThanOrEqual(0);
    expect(placement.top + CALLOUT.height).toBeLessThanOrEqual(VIEWPORT.height);
    expect(placement.left + CALLOUT.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it("clamps on-screen even for a corner target with a callout as big as the viewport", () => {
    const target = rect({ top: 0, left: 0, width: 10, height: 10 });
    const hugeCallout = { width: 1200, height: 800 };
    const placement = computeCalloutPlacement(target, VIEWPORT, hugeCallout, 16);
    expect(placement.top).toBeGreaterThanOrEqual(0);
    expect(placement.left).toBeGreaterThanOrEqual(0);
  });
});

describe("computeArrowOffset", () => {
  it("points at the target's vertical center for a left/right callout", () => {
    const target = rect({ top: 300, left: 500, width: 100, height: 40 });
    const placement = computeCalloutPlacement(target, VIEWPORT, CALLOUT, 16);
    const offset = computeArrowOffset(placement, target, CALLOUT);
    const expected = target.top + target.height / 2 - placement.top;
    expect(offset).toBeCloseTo(Math.min(Math.max(expected, 16), CALLOUT.height - 16));
  });

  it("clamps the arrow away from the callout's rounded corners", () => {
    // Target center far outside the callout's own bounds should still clamp inside it.
    const target = rect({ top: -500, left: 500, width: 100, height: 40 });
    const placement = computeCalloutPlacement(target, VIEWPORT, CALLOUT, 16);
    const offset = computeArrowOffset(placement, target, CALLOUT, 10, 16);
    expect(offset).toBeGreaterThanOrEqual(16);
    expect(offset).toBeLessThanOrEqual(CALLOUT.height - 16);
  });
});

describe("padRect", () => {
  it("grows a rect symmetrically on every side", () => {
    const target = rect({ top: 100, left: 200, width: 50, height: 30 });
    const padded = padRect(target, 8);
    expect(padded).toEqual({ top: 92, left: 192, width: 66, height: 46 });
  });
});

describe("buildSpotlightPath", () => {
  it("includes the full viewport outer rect and the hole's coordinates", () => {
    const hole = rect({ top: 100, left: 200, width: 50, height: 30 });
    const d = buildSpotlightPath(hole, VIEWPORT, 12);
    expect(d).toContain(`M0,0 H${VIEWPORT.width} V${VIEWPORT.height} H0 Z`);
    // Rounded-rect hole starts inset by the radius from its top-left corner.
    expect(d).toContain(`M${hole.left + 12},${hole.top}`);
  });

  it("falls back to a square (non-rounded) hole when radius is 0", () => {
    const hole = rect({ top: 10, left: 10, width: 40, height: 40 });
    const d = buildSpotlightPath(hole, VIEWPORT, 0);
    expect(d).toContain(`M${hole.left},${hole.top} H${hole.left + hole.width}`);
  });

  it("clamps an oversized radius down so it never exceeds half the hole's own size", () => {
    const hole = rect({ top: 10, left: 10, width: 20, height: 20 });
    const d = buildSpotlightPath(hole, VIEWPORT, 999);
    // radius clamps to 10 (half of 20), so the rounded path should start at left+10
    expect(d).toContain(`M${hole.left + 10},${hole.top}`);
  });
});
