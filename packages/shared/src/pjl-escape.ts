// Detects the printer escape sequences that would let a document break out of PJL "ENTER LANGUAGE=PDF" mode
// when its bytes are streamed to a raw port (TCP 9100). The Universal Exit Language is ESC % - 1 2 3 4 5 X;
// after it the printer parses whatever follows as PJL. A PDF has no legitimate reason to contain it.
// We are deliberately stricter than the spec: the final X is matched case-insensitively and any ESC followed
// within a few bytes by "@PJL" is refused as well. A false positive just asks for a re-saved copy.

export const PJL_ESCAPE_MESSAGE =
  "This PDF contains printer control codes, so it can't be printed. Open it, choose Print, then Save as PDF, and upload that copy.";

const ESC = 0x1b;
const UEL_REST = [0x25, 0x2d, 0x31, 0x32, 0x33, 0x34, 0x35]; // % - 1 2 3 4 5, then X/x
const PJL = [0x40, 0x50, 0x4a, 0x4c]; // @PJL
const PJL_WINDOW = 16; // how far after an ESC an "@PJL" still counts
/** Bytes that must be kept between chunks so nothing split across a boundary is missed. */
const OVERLAP = PJL_WINDOW + PJL.length + 1;

function upper(b: number): number {
  return b >= 0x61 && b <= 0x7a ? b - 0x20 : b;
}

/** True when an ESC at `i` starts a UEL or is followed closely by @PJL. Bytes past the end count as no match. */
function escapeAt(b: Uint8Array, i: number): boolean {
  const n = b.length;
  let k = 0;
  while (k < UEL_REST.length && i + 1 + k < n && b[i + 1 + k] === UEL_REST[k]) k++;
  if (k === UEL_REST.length && i + 1 + k < n && upper(b[i + 1 + k]!) === 0x58) return true;
  const last = Math.min(n - PJL.length, i + 1 + PJL_WINDOW);
  for (let s = i + 1; s <= last; s++) {
    if (b[s] === 0x40) {
      let m = 0;
      while (m < PJL.length && upper(b[s + m]!) === PJL[m]) m++;
      if (m === PJL.length) return true;
    }
  }
  return false;
}

export function containsPjlEscape(bytes: Uint8Array): boolean {
  let i = bytes.indexOf(ESC);
  while (i !== -1) {
    if (escapeAt(bytes, i)) return true;
    i = bytes.indexOf(ESC, i + 1);
  }
  return false;
}

export interface PjlEscapeScanner {
  /** Feed the next chunk; returns true as soon as a dangerous sequence has been seen (and stays true). */
  push(chunk: Uint8Array): boolean;
}

/** Incremental version of containsPjlEscape for streamed bodies; sequences split across chunks are found. */
export function createPjlEscapeScanner(): PjlEscapeScanner {
  let tail: Uint8Array = new Uint8Array(0);
  let found = false;
  return {
    push(chunk) {
      if (found) return true;
      const buf = new Uint8Array(tail.length + chunk.length);
      buf.set(tail, 0);
      buf.set(chunk, tail.length);
      if (containsPjlEscape(buf)) {
        found = true;
        return true;
      }
      tail = buf.slice(Math.max(0, buf.length - OVERLAP));
      return false;
    },
  };
}
