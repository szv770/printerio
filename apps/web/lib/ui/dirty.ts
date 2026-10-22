/**
 * Pure dirty-detection for forms: compares current values with the values the
 * form last loaded or saved. Used by useDirtyForm and unit tested on its own.
 *
 * Values may be strings, numbers, booleans, null/undefined, arrays or plain
 * objects. Line endings in strings are normalised (a textarea round-trips
 * "\r\n" to "\n"), nothing else is: a trailing space is a real change.
 */

function normalise(v: unknown): unknown {
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n") : v;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  a = normalise(a);
  b = normalise(b);
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return a == null && b == null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => valuesEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in (b as object) && valuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** Keys whose current value differs from the baseline. */
export function dirtyKeys<T extends Record<string, unknown>>(initial: T, current: T): Array<keyof T> {
  return (Object.keys(current) as Array<keyof T>).filter((k) => !valuesEqual(initial[k], current[k]));
}

export function isDirty<T extends Record<string, unknown>>(initial: T, current: T): boolean {
  return dirtyKeys(initial, current).length > 0;
}

/** New baseline after a (partial) save: the listed keys take their current
 *  value, every other key keeps its old baseline (so it stays dirty). */
export function commitKeys<T extends Record<string, unknown>>(initial: T, current: T, keys: Array<keyof T>): T {
  const next = { ...initial };
  for (const k of keys) next[k] = current[k];
  return next;
}
