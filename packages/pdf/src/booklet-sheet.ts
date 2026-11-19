/**
 * Which sheet a booklet is printed on.
 *  - "letter" (regular): the paper the job already uses; each page shrinks to a half-sheet (statement-size) cell.
 *  - "tabloid" (11x17): Letter pages stay about full size on an 11x17 sheet, saddle-stitched. The whole page is kept
 *    (never cropped or enlarged past its cell), so a Letter page comes out as a Letter page.
 * UNVERIFIED on the printer: the raw path sends no paper size, so the printer has to choose 11x17 from the page size.
 *
 * Lives in its own file (no pdf-lib import) so a caller that only needs the type or the parser does not load the PDF library.
 */
export type BookletSheet = "letter" | "tabloid";

export function bookletSheetChoice(value: unknown): BookletSheet {
  return value === "tabloid" ? "tabloid" : "letter";
}
