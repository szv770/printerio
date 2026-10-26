import { parsePageRange } from "@printio/shared";

/**
 * Tap-to-pick pages: the pure part. The form keeps ONE source of truth, the page range text (what is submitted and what
 * the server re-checks). Tapping pages writes that text, and the text typed by hand is read back into taps, so the two
 * ways of choosing can never disagree.
 */

/** "1-3, 5, 8-10": runs written as ranges, singles as numbers, sorted, no duplicates, nothing outside 1..n. */
export function pagesToRangeText(pages: readonly number[]): string {
  const sorted = [...new Set(pages.filter((p) => Number.isInteger(p) && p >= 1))].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(", ");
}

/** The pages a typed range means, or none when it is empty or not valid (the form shows its own error for that). */
export function rangeTextToPages(text: string, totalPages: number): number[] {
  if (!text.trim() || totalPages < 1) return [];
  const parsed = parsePageRange(text, totalPages);
  return parsed.ok ? [...parsed.pages].sort((a, b) => a - b) : [];
}

export function togglePage(selected: readonly number[], page: number, totalPages: number): number[] {
  if (!Number.isInteger(page) || page < 1 || page > totalPages) return [...selected];
  return selected.includes(page) ? selected.filter((p) => p !== page) : [...selected, page].sort((a, b) => a - b);
}

export type QuickKind = "all" | "none" | "first" | "last" | "first3" | "last3" | "odd" | "even" | "invert";

export function quickSelection(kind: QuickKind, totalPages: number, current: readonly number[] = []): number[] {
  const all = Array.from({ length: Math.max(0, totalPages) }, (_, i) => i + 1);
  switch (kind) {
    case "all":
      return all;
    case "none":
      return [];
    case "first":
      return all.slice(0, 1);
    case "last":
      return all.slice(-1);
    case "first3":
      return all.slice(0, 3);
    case "last3":
      return all.slice(-3);
    case "odd":
      return all.filter((p) => p % 2 === 1);
    case "even":
      return all.filter((p) => p % 2 === 0);
    case "invert": {
      const have = new Set(current);
      return all.filter((p) => !have.has(p));
    }
  }
}
