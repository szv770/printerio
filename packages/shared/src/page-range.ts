/**
 * Page range parsing for the upload page / IPP page-ranges.
 * 1-based, de-duplicated, order preserved. Strict: anything unrecognised is an error
 * rather than silently printing the wrong pages.
 */
export const MAX_PAGE_RANGE_INPUT_LENGTH = 200;

export type PageRangeResult = { ok: true; pages: number[] } | { ok: false; reason: string };

const SINGLE = /^[0-9]{1,9}$/;
const RANGE = /^([0-9]{1,9})\s*-\s*([0-9]{1,9})?$/;
const LEADING_OPEN = /^-\s*([0-9]{1,9})$/;

function fail(reason: string): PageRangeResult {
  return { ok: false, reason };
}

export function parsePageRange(input: string, totalPages: number): PageRangeResult {
  if (!Number.isInteger(totalPages) || totalPages < 1) return fail("The document has no pages to choose from.");
  if (typeof input !== "string") return fail("Enter a page range such as 1-5, 8.");
  if (input.length > MAX_PAGE_RANGE_INPUT_LENGTH) return fail("That page range is too long.");

  const seen = new Set<number>();
  const pages: number[] = [];
  const add = (p: number) => {
    if (!seen.has(p)) {
      seen.add(p);
      pages.push(p);
    }
  };

  for (const raw of input.split(",")) {
    const item = raw.trim();
    if (item === "") continue;

    let start: number;
    let end: number;
    let m: RegExpExecArray | null;
    if (SINGLE.test(item)) {
      start = end = Number(item);
    } else if ((m = RANGE.exec(item))) {
      start = Number(m[1]);
      end = m[2] === undefined ? totalPages : Number(m[2]);
    } else if ((m = LEADING_OPEN.exec(item))) {
      start = 1;
      end = Number(m[1]);
    } else {
      return fail(`"${item.slice(0, 20)}" is not a valid page or range. Use a form like 1-5, 8.`);
    }

    if (start < 1 || end < 1) return fail("Page numbers start at 1.");
    if (start > end) return fail(`"${item}" runs backwards. Put the smaller page first.`);
    if (end > totalPages) return fail(`The document only has ${totalPages} page${totalPages === 1 ? "" : "s"}.`);
    for (let p = start; p <= end; p++) add(p);
  }

  if (pages.length === 0) return fail("Enter at least one page.");
  return { ok: true, pages };
}
