/** The choices the booklet builder hands to the Print screen, in one place so both sides agree. */
export type SheetChoice = "letter" | "tabloid";

export function builderPrintUrl(direction: "ltr" | "rtl", sheet: SheetChoice): string {
  return `/print?built=1&booklet=${direction === "rtl" ? "right" : "left"}&sheet=${sheet}`;
}

export function readBuilderParams(search: string): { booklet: "left" | "right" | null; sheet: SheetChoice | null } {
  const params = new URLSearchParams(search);
  const booklet = params.get("booklet");
  const sheet = params.get("sheet");
  return {
    booklet: booklet === "left" || booklet === "right" ? booklet : null,
    sheet: sheet === "letter" || sheet === "tabloid" ? sheet : null,
  };
}

/** One file picked in the library, going straight to the Print screen, optionally with the pages to use (e.g. "4-18"). */
export function singleFilePrintUrl(pages?: string): string {
  return pages ? `/print?built=1&pages=${pages}` : "/print?built=1";
}

/** A plain page range from the address ("4-18" or "7"); anything else is ignored. */
export function readPagesParam(search: string): string | null {
  const v = new URLSearchParams(search).get("pages");
  return v !== null && /^\d{1,4}(-\d{1,4})?$/.test(v) ? v : null;
}
