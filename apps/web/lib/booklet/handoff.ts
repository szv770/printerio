/**
 * Carries the finished booklet from the builder page to the Print page. A merged PDF can be tens of megabytes, too big for
 * the address bar or session storage, so it waits here in memory for the in-app navigation that follows. If the person
 * reloads or opens /print some other way the file is simply gone, and nothing is lost: the builder can build it again.
 */
let waiting: { file: File; at: number } | null = null;
const MAX_AGE_MS = 10 * 60 * 1000;

export function putBuiltBooklet(file: File, now = Date.now()): void {
  waiting = { file, at: now };
}

/** Hands the file over once. Returns null when there is none or it has waited too long. */
export function takeBuiltBooklet(now = Date.now()): File | null {
  const got = waiting;
  waiting = null;
  return got && now - got.at <= MAX_AGE_MS ? got.file : null;
}
