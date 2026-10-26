/** The 8 page booklet on the home page: which page sits where at each point of flipping through it. Laid out for a
 *  left-to-right book (spine on the left, cover on the right); the Hebrew view mirrors the whole book. */
export const BOOKLET_PAGES = 8;
/** Cover; pages 2-3; 4-5; 6-7; back. */
export const SPREAD_COUNT = BOOKLET_PAGES / 2 + 1;

export interface Spread {
  left: number | null;
  right: number | null;
}

export function bookletSpread(index: number): Spread {
  if (!Number.isInteger(index) || index < 0 || index >= SPREAD_COUNT) throw new Error(`spread ${index} is out of range`);
  if (index === 0) return { left: null, right: 1 };
  if (index === SPREAD_COUNT - 1) return { left: BOOKLET_PAGES, right: null };
  return { left: 2 * index, right: 2 * index + 1 };
}

export function spreadCaption(index: number): string {
  const s = bookletSpread(index);
  if (index === 0) return "The cover, page 1";
  if (index === SPREAD_COUNT - 1) return `The back, page ${s.left}`;
  return `Pages ${s.left} and ${s.right}`;
}
