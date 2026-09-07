/**
 * Pure geometry for the onboarding spotlight tour (components/help/SpotlightTour.tsx).
 * Kept dependency-free and DOM-free on purpose - everything here takes plain
 * rects/sizes in and returns plain numbers/strings out, so it can be unit
 * tested directly (see tour-position.test.ts) instead of only ever being
 * exercised by clicking through a real browser.
 */

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type CalloutSide = "top" | "bottom" | "left" | "right";

export interface CalloutPlacement {
  side: CalloutSide;
  top: number;
  left: number;
}

const SIDE_ORDER: CalloutSide[] = ["right", "left", "bottom", "top"];

/** How much viewport space is available on each side of `target`, net of `gap`. */
export function availableSpace(target: Rect, viewport: Size, gap: number): Record<CalloutSide, number> {
  return {
    right: viewport.width - (target.left + target.width) - gap,
    left: target.left - gap,
    bottom: viewport.height - (target.top + target.height) - gap,
    top: target.top - gap,
  };
}

/**
 * Picks which side of the target the callout should render on: the first
 * side (in right/left/bottom/top preference order - right reads most
 * naturally for left-to-right copy) that actually has room for the callout's
 * own size, net of `gap`. When nothing fits (a very large callout against a
 * tiny viewport, or a target that fills the screen), falls back to whichever
 * side has the most space rather than picking arbitrarily - it will be
 * clamped on-screen either way by clampToViewport.
 */
export function pickSide(target: Rect, viewport: Size, callout: Size, gap: number): CalloutSide {
  const space = availableSpace(target, viewport, gap);
  const needed: Record<CalloutSide, number> = {
    right: callout.width,
    left: callout.width,
    bottom: callout.height,
    top: callout.height,
  };

  for (const side of SIDE_ORDER) {
    if (space[side] >= needed[side]) return side;
  }

  let best: CalloutSide = "right";
  for (const side of SIDE_ORDER) {
    if (space[side] > space[best]) best = side;
  }
  return best;
}

/** Clamps a single-axis position so `size` stays fully within `[0, viewportSize]`, with `margin` breathing room from the edge. */
export function clampAxis(position: number, size: number, viewportSize: number, margin = 8): number {
  const max = Math.max(margin, viewportSize - size - margin);
  return Math.min(Math.max(position, margin), max);
}

/** Clamps a fully-positioned callout box so it never renders off-screen. */
export function clampToViewport(top: number, left: number, callout: Size, viewport: Size, margin = 8): { top: number; left: number } {
  return {
    top: clampAxis(top, callout.height, viewport.height, margin),
    left: clampAxis(left, callout.width, viewport.width, margin),
  };
}

/**
 * Computes where the callout should render for a given target/viewport/
 * callout size: which side of the target it sits on (auto-flipping to
 * whichever side has room), and its clamped top/left in viewport
 * coordinates. `gap` is the breathing room between the target's highlight
 * and the callout itself.
 */
export function computeCalloutPlacement(target: Rect, viewport: Size, callout: Size, gap = 16): CalloutPlacement {
  const side = pickSide(target, viewport, callout, gap);

  let top: number;
  let left: number;

  if (side === "right" || side === "left") {
    top = target.top + target.height / 2 - callout.height / 2;
    left = side === "right" ? target.left + target.width + gap : target.left - gap - callout.width;
  } else {
    left = target.left + target.width / 2 - callout.width / 2;
    top = side === "bottom" ? target.top + target.height + gap : target.top - gap - callout.height;
  }

  const clamped = clampToViewport(top, left, callout, viewport);
  return { side, top: clamped.top, left: clamped.left };
}

/**
 * The offset (from the callout's own top-left corner) at which its pointer/
 * arrow should sit so it keeps pointing at the target's center, clamped so
 * the arrow never renders past the callout's own rounded corners.
 */
export function computeArrowOffset(placement: CalloutPlacement, target: Rect, callout: Size, arrowSize = 10, cornerInset = 16): number {
  if (placement.side === "top" || placement.side === "bottom") {
    const targetCenterX = target.left + target.width / 2;
    return Math.min(Math.max(targetCenterX - placement.left, cornerInset), callout.width - cornerInset);
  }
  const targetCenterY = target.top + target.height / 2;
  return Math.min(Math.max(targetCenterY - placement.top, cornerInset), callout.height - cornerInset);
}

/** Inflates a rect by `padding` on every side - used to give the spotlight cutout some breathing room around the actual element. */
export function padRect(rect: Rect, padding: number): Rect {
  return {
    top: rect.top - padding,
    left: rect.left - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

/**
 * Builds the `d` attribute for a full-viewport SVG path with a rounded-rect
 * hole cut out over `hole` (evenodd fill rule - the hole is genuinely absent
 * from the path's geometry, not just painted transparently, so clicks over
 * it hit whatever real element is underneath rather than this overlay).
 */
export function buildSpotlightPath(hole: Rect, viewport: Size, radius = 12): string {
  const r = Math.max(0, Math.min(radius, hole.width / 2, hole.height / 2));
  const x = hole.left;
  const y = hole.top;
  const w = hole.width;
  const h = hole.height;

  const outer = `M0,0 H${viewport.width} V${viewport.height} H0 Z`;
  const inner =
    r <= 0
      ? `M${x},${y} H${x + w} V${y + h} H${x} Z`
      : [
          `M${x + r},${y}`,
          `H${x + w - r}`,
          `A${r},${r} 0 0 1 ${x + w},${y + r}`,
          `V${y + h - r}`,
          `A${r},${r} 0 0 1 ${x + w - r},${y + h}`,
          `H${x + r}`,
          `A${r},${r} 0 0 1 ${x},${y + h - r}`,
          `V${y + r}`,
          `A${r},${r} 0 0 1 ${x + r},${y} Z`,
        ].join(" ");

  return `${outer} ${inner}`;
}
