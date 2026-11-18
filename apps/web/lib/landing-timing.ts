/**
 * One set of numbers for the home page demo's timing, used by BOTH the animation (CSS custom properties) and the
 * sound (audio scheduling), so a sound can never drift away from the moment it belongs to. All times are
 * milliseconds. The CSS keyframes put each "hit" at the same fraction of their duration as written here.
 */
export type Finish = "none" | "staple" | "booklet";

/** When each phase starts, counted from the press of Print. Phase 4 (finishing) only happens for staple/booklet. */
export const PHASE_AT_MS = { sending: 0, checking: 900, printing: 2600, delivered: 4100 } as const;

/** The stapler arm comes down, hits, and lifts: one stroke. */
export const STAPLE_STROKE_MS = 900;
/** The arm reaches the page this far through its stroke (the keyframe says 40%). */
export const STAPLE_HIT_FRACTION = 0.4;

/** Booklet: the left half folds behind the cover, then two stitches go in along the spine. */
export const FOLD_MS = 900;
export const STITCH_AT_MS = [FOLD_MS + 120, FOLD_MS + 340] as const;
export const STITCH_POP_MS = 260;

export function stapleHitMs(): number {
  return Math.round(STAPLE_STROKE_MS * STAPLE_HIT_FRACTION);
}

/** How long finishing lasts, from the moment the sheet is delivered. */
export function finishMs(finish: Finish): number {
  if (finish === "staple") return STAPLE_STROKE_MS + 350;
  if (finish === "booklet") return STITCH_AT_MS[1] + STITCH_POP_MS + 450;
  return 0;
}

/** Total time from the press of Print until everything is finished. */
export function totalMs(finish: Finish): number {
  return PHASE_AT_MS.delivered + finishMs(finish);
}
