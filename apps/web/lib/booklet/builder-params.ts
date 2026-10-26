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
