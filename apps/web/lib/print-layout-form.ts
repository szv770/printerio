/**
 * The print form's page-layout fields (several pages per sheet, or one page repeated on a sheet) as PURE helpers.
 * No React and no server imports: the server action parses the submitted fields with `parseLayoutForm` (the source of truth,
 * strict bounds), and the form's Layout section uses the same shapes and arithmetic so what it shows is what will be sent.
 *
 * Deliberately NOT importing `@printio/pdf/nup` (it pulls pdf-lib into the server action): the shape is the shared
 * `PresetLayout` (structurally the same as packages/pdf `LayoutSpec`), and `preparePdf` validates the rest.
 *
 * Form fields: layoutMode none|nup|repeat, layoutCols, layoutRows, layoutMarks, layoutBorder, layoutRepeatPages each|first.
 */
import type { PresetLayout } from "@printio/shared";

export const LAYOUT_MAX_ACROSS = 4;
export const LAYOUT_MAX_CELLS = 12;

export type ParsedLayout = { ok: true; layout?: PresetLayout } | { ok: false; reason: string };

export const BOOKLET_LAYOUT_CONFLICT = "A booklet and pages per sheet cannot be combined. Turn one of them off.";

function flag(raw: FormDataEntryValue | null, field: string): { ok: true; value: boolean } | { ok: false; reason: string } {
  if (raw === null) return { ok: true, value: false };
  if (typeof raw !== "string") return { ok: false, reason: `The ${field} choice is not valid.` };
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "false" || v === "off" || v === "0") return { ok: true, value: false };
  if (v === "true" || v === "on" || v === "1") return { ok: true, value: true };
  return { ok: false, reason: `The ${field} choice is not valid.` };
}

function count(raw: FormDataEntryValue | null, what: string): { ok: true; value: number } | { ok: false; reason: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,2}$/.test(text)) return { ok: false, reason: `Choose how many ${what} to print (1 to ${LAYOUT_MAX_ACROSS}).` };
  const n = parseInt(text, 10);
  if (n < 1 || n > LAYOUT_MAX_ACROSS) return { ok: false, reason: `Choose how many ${what} to print (1 to ${LAYOUT_MAX_ACROSS}).` };
  return { ok: true, value: n };
}

/**
 * Reads the layout fields from the submitted form. `booklet` is the parsed booklet choice: a booklet already is its own
 * layout, so asking for both is refused with a plain message. No layout asked for (mode absent or "none") is `{ ok: true }`
 * with no layout, and the other layout fields are then ignored.
 */
export function parseLayoutForm(get: (name: string) => FormDataEntryValue | null, booklet: string): ParsedLayout {
  const modeRaw = get("layoutMode");
  const mode = typeof modeRaw === "string" ? modeRaw.trim() : "";
  if (mode === "" || mode === "none") return { ok: true };
  if (mode !== "nup" && mode !== "repeat") return { ok: false, reason: "That page layout is not available." };
  if (booklet !== "none") return { ok: false, reason: BOOKLET_LAYOUT_CONFLICT };

  const cols = count(get("layoutCols"), "pages across");
  if (!cols.ok) return cols;
  const rows = count(get("layoutRows"), "pages down");
  if (!rows.ok) return rows;
  if (cols.value * rows.value > LAYOUT_MAX_CELLS) return { ok: false, reason: `A sheet can hold at most ${LAYOUT_MAX_CELLS} pages.` };
  const border = flag(get("layoutBorder"), "border");
  if (!border.ok) return border;

  if (mode === "nup") {
    return { ok: true, layout: { kind: "nup", cols: cols.value, rows: rows.value, ...(border.value ? { border: true } : {}) } };
  }

  const marks = flag(get("layoutMarks"), "cut marks");
  if (!marks.ok) return marks;
  const pagesRaw = get("layoutRepeatPages");
  const pages = typeof pagesRaw === "string" && pagesRaw.trim() !== "" ? pagesRaw.trim() : "each";
  if (pages !== "each" && pages !== "first") return { ok: false, reason: "Choose to repeat every page or only the first page." };
  return {
    ok: true,
    layout: { kind: "repeat", cols: cols.value, rows: rows.value, pages, ...(marks.value ? { marks: true } : {}), ...(border.value ? { border: true } : {}) },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What the form's Layout section holds, and how it maps to the fields above. The server re-checks everything.

export type LayoutMode = "none" | "nup" | "repeat";

export interface LayoutUi {
  mode: LayoutMode;
  /** Pages per sheet (mode nup). */
  perSheet: 2 | 4;
  /** Copies of the same page on one sheet (mode repeat). */
  copies: 2 | 4;
  /** Cut marks (mode repeat). */
  marks: boolean;
  /** Which pages repeat (mode repeat). */
  repeatPages: "each" | "first";
}

export const NO_LAYOUT: LayoutUi = { mode: "none", perSheet: 2, copies: 2, marks: true, repeatPages: "each" };

/** 2 across and 1 down for two, 2 by 2 for four. */
function grid(n: 2 | 4): { cols: number; rows: number } {
  return n === 2 ? { cols: 2, rows: 1 } : { cols: 2, rows: 2 };
}

export function layoutFromUi(ui: LayoutUi): PresetLayout | undefined {
  if (ui.mode === "none") return undefined;
  if (ui.mode === "nup") return { kind: "nup", ...grid(ui.perSheet) };
  return { kind: "repeat", ...grid(ui.copies), pages: ui.repeatPages, ...(ui.marks ? { marks: true } : {}) };
}

/** The hidden form fields for the current Layout section. */
export function layoutFields(ui: LayoutUi): Record<string, string> {
  const layout = layoutFromUi(ui);
  if (!layout) return { layoutMode: "none", layoutCols: "1", layoutRows: "1", layoutMarks: "false", layoutBorder: "false", layoutRepeatPages: "each" };
  return {
    layoutMode: layout.kind,
    layoutCols: String(layout.cols),
    layoutRows: String(layout.rows),
    layoutMarks: layout.kind === "repeat" && layout.marks ? "true" : "false",
    layoutBorder: layout.border ? "true" : "false",
    layoutRepeatPages: layout.kind === "repeat" && layout.pages === "first" ? "first" : "each",
  };
}

/** What a preset's layout looks like in the Layout section (a layout the section cannot show, such as 3 by 3, falls back to the nearest). */
export function layoutUiFromPreset(layout: PresetLayout | undefined): LayoutUi {
  if (!layout) return NO_LAYOUT;
  const cells = layout.cols * layout.rows;
  const n: 2 | 4 = cells <= 2 ? 2 : 4;
  if (layout.kind === "nup") return { ...NO_LAYOUT, mode: "nup", perSheet: n };
  return { ...NO_LAYOUT, mode: "repeat", copies: n, marks: !!layout.marks, repeatPages: layout.pages === "first" ? "first" : "each" };
}

/** Whether two layouts ask for the same thing (used to show which quick setting is selected). */
export function sameLayout(a: PresetLayout | undefined, b: PresetLayout | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.kind !== b.kind || a.cols !== b.cols || a.rows !== b.rows || !!a.border !== !!b.border) return false;
  if (a.kind === "repeat" && b.kind === "repeat") return a.pages === b.pages && !!a.marks === !!b.marks;
  return true;
}

/** Sheet faces for `pages` pages with this layout (one copy), or null when the page count is not known. An estimate: the server counts again. */
export function layoutSides(layout: PresetLayout | undefined, pages: number | null): number | null {
  if (!layout || !pages || pages < 1) return null;
  if (layout.kind === "nup") return Math.ceil(pages / (layout.cols * layout.rows));
  return layout.pages === "first" ? 1 : pages;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The one plain line under the Layout section: "4 pages become 2 sheets" (an estimate), or what a sheet will hold when the count is unknown. */
export function layoutSummary(layout: PresetLayout | undefined, pages: number | null, duplex: boolean): string | null {
  if (!layout) return null;
  const cells = layout.cols * layout.rows;
  const sides = layoutSides(layout, pages);
  if (layout.kind === "nup") {
    if (sides === null || !pages) return `Each sheet holds ${cells} pages.`;
    const sheets = duplex ? Math.ceil(sides / 2) : sides;
    return `${plural(pages, "page", "pages")} become ${plural(sheets, "sheet", "sheets")}`;
  }
  const what = layout.pages === "first" ? "The first page is" : "Each page is";
  if (sides === null || !pages) return `${what} printed ${cells} times on one sheet.`;
  const sheets = duplex ? Math.ceil(sides / 2) : sides;
  return `${what} printed ${cells} times: ${plural(sheets, "sheet", "sheets")} in all`;
}
