/**
 * Just enough right-to-left layout for a booklet's cover and contents pages. A PDF draws glyphs in the order it is told,
 * left to right, so a Hebrew title has to be handed over in VISUAL order. This implements the useful core of the Unicode
 * bidirectional algorithm for short lines (titles, descriptions, contents entries): Hebrew runs read right to left,
 * Latin text and numbers keep their own order, neutral characters (spaces, punctuation) take the direction around them,
 * and brackets are mirrored inside right-to-left runs. It is not a full implementation (no Arabic joining, no embeddings).
 */

export type Direction = "ltr" | "rtl";

const isHebrew = (c: string) => /[֐-׿יִ-ﭏ]/.test(c);
const isLatinLetter = (c: string) => /[A-Za-zÀ-ɏ]/.test(c);
const isDigit = (c: string) => /[0-9]/.test(c);

export function hasHebrew(text: string): boolean {
  return /[֐-׿יִ-ﭏ]/.test(text);
}

/** The direction of a line: that of its first letter (digits and punctuation have none); left to right if there is none. */
export function paragraphDirection(text: string): Direction {
  for (const c of text) {
    if (isHebrew(c)) return "rtl";
    if (isLatinLetter(c)) return "ltr";
  }
  return "ltr";
}

const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };
/** Punctuation that stays inside a number: 1,000  5711-01-01  3.5  10:30  1/2 */
const NUMBER_JOINERS = new Set([",", ".", "-", ":", "/"]);

type Kind = "R" | "L" | "N";

export function visualOrder(text: string, direction: Direction): string {
  return visualRuns(text, direction).map((r) => r.text).join("");
}

/** The same layout as `visualOrder`, kept as runs from left to right so the caller knows which runs read right to left. */
export function visualRuns(text: string, direction: Direction): { text: string; rtl: boolean }[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];

  // 1. Strong direction of every character; digits count as left-to-right.
  const kinds: Kind[] = chars.map((c) => (isHebrew(c) ? "R" : isLatinLetter(c) || isDigit(c) ? "L" : "N"));

  // 2. A joiner between two digits belongs to the number (so 5711-01-01 stays one left-to-right run).
  for (let i = 1; i < chars.length - 1; i++) {
    if (kinds[i] === "N" && NUMBER_JOINERS.has(chars[i]!) && isDigit(chars[i - 1]!) && isDigit(chars[i + 1]!)) kinds[i] = "L";
  }

  // 2b. A matched pair of brackets takes the direction of what is inside it when that differs from the line's: a pair
  //     around English text stays with that text (and is not mirrored), instead of being pulled to the line's end.
  const paraKind: Kind = direction === "rtl" ? "R" : "L";
  const openers = new Set(["(", "[", "{", "<"]);
  const stack: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (openers.has(c)) {
      stack.push(i);
    } else if (MIRROR[c] && !openers.has(c) && stack.length > 0) {
      const open = stack.pop()!;
      if (MIRROR[chars[open]!] !== c) continue; // not a matching pair
      const inside = new Set(kinds.slice(open + 1, i).filter((k) => k !== "N"));
      if (inside.size === 0 || inside.has(paraKind)) continue; // nothing inside, or text in the line's own direction: normal rules
      const other: Kind = paraKind === "R" ? "L" : "R";
      let before: Kind | null = null;
      for (let k = open - 1; k >= 0; k--) {
        if (kinds[k] !== "N") {
          before = kinds[k]!;
          break;
        }
      }
      // Only text in the other direction inside, and the same direction just before the bracket: it belongs with it.
      const dir: Kind = before === other ? other : paraKind;
      kinds[open] = dir;
      kinds[i] = dir;
    }
  }

  // 3. Neutrals take the direction of the strong text on BOTH sides when they agree, otherwise the line's direction.
  const para: Kind = direction === "rtl" ? "R" : "L";
  const resolved = [...kinds];
  for (let i = 0; i < chars.length; i++) {
    if (kinds[i] !== "N") continue;
    let a = i - 1;
    while (a >= 0 && kinds[a] === "N") a--;
    let b = i + 1;
    while (b < chars.length && kinds[b] === "N") b++;
    const before = a >= 0 ? kinds[a]! : para;
    const after = b < chars.length ? kinds[b]! : para;
    resolved[i] = before === after ? before : para;
  }

  // 4. Runs of the same direction.
  const runs: { dir: "R" | "L"; text: string[] }[] = [];
  chars.forEach((c, i) => {
    const dir = resolved[i] as "R" | "L";
    const last = runs[runs.length - 1];
    if (last && last.dir === dir) last.text.push(c);
    else runs.push({ dir, text: [c] });
  });

  // 5. Right-to-left runs are drawn backwards (brackets mirrored); in a right-to-left line the runs themselves go
  //    right to left, so their order is reversed too.
  const drawn = runs.map((r) => ({ text: r.dir === "R" ? [...r.text].reverse().map((c) => MIRROR[c] ?? c).join("") : r.text.join(""), rtl: r.dir === "R" }));
  return direction === "rtl" ? drawn.reverse() : drawn;
}
