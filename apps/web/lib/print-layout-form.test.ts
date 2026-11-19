import { describe, expect, it } from "vitest";
import { PRINT_PRESETS } from "@printio/shared";
import {
  BOOKLET_LAYOUT_CONFLICT,
  NO_LAYOUT,
  layoutFields,
  layoutFromUi,
  layoutSummary,
  layoutUiFromPreset,
  parseLayoutForm,
  sameLayout,
} from "./print-layout-form";

const fromObj = (o: Record<string, string>) => (name: string) => (name in o ? o[name]! : null);
const parse = (o: Record<string, string>, booklet = "none") => parseLayoutForm(fromObj(o), booklet);

describe("parseLayoutForm", () => {
  it("no layout asked for means no layout", () => {
    expect(parse({})).toEqual({ ok: true });
    expect(parse({ layoutMode: "none", layoutCols: "9" })).toEqual({ ok: true });
  });
  it("parses pages per sheet and repeat", () => {
    expect(parse({ layoutMode: "nup", layoutCols: "2", layoutRows: "2" })).toEqual({ ok: true, layout: { kind: "nup", cols: 2, rows: 2 } });
    expect(parse({ layoutMode: "repeat", layoutCols: "2", layoutRows: "1", layoutMarks: "on", layoutRepeatPages: "first" })).toEqual({
      ok: true,
      layout: { kind: "repeat", cols: 2, rows: 1, pages: "first", marks: true },
    });
  });
  it("enforces 1..4 across and down and at most 12 cells", () => {
    for (const bad of ["0", "5", "-1", "2.5", "abc", ""]) expect(parse({ layoutMode: "nup", layoutCols: bad, layoutRows: "1" }).ok, bad).toBe(false);
    expect(parse({ layoutMode: "nup", layoutCols: "4", layoutRows: "4" })).toMatchObject({ ok: false, reason: expect.stringMatching(/at most 12/) });
    expect(parse({ layoutMode: "nup", layoutCols: "4", layoutRows: "3" }).ok).toBe(true);
    expect(parse({ layoutMode: "nup", layoutCols: "2" }).ok).toBe(false);
  });
  it("rejects a booklet together with a layout, with a plain message", () => {
    expect(parse({ layoutMode: "nup", layoutCols: "2", layoutRows: "1" }, "left")).toEqual({ ok: false, reason: BOOKLET_LAYOUT_CONFLICT });
    expect(parse({ layoutMode: "none" }, "left")).toEqual({ ok: true });
  });
  it("rejects anything else", () => {
    expect(parse({ layoutMode: "grid", layoutCols: "2", layoutRows: "1" }).ok).toBe(false);
    expect(parse({ layoutMode: "repeat", layoutCols: "2", layoutRows: "1", layoutRepeatPages: "3" }).ok).toBe(false);
    expect(parse({ layoutMode: "repeat", layoutCols: "2", layoutRows: "1", layoutMarks: "maybe" }).ok).toBe(false);
  });
});

describe("the form's Layout section mirrors the server", () => {
  it("every built-in preset's layout survives ui -> fields -> parse unchanged", () => {
    for (const p of PRINT_PRESETS) {
      const ui = layoutUiFromPreset(p.layout);
      expect(layoutFromUi(ui), p.id).toEqual(p.layout);
      const parsed = parseLayoutForm(fromObj(layoutFields(ui)), p.choices.booklet);
      expect(parsed, p.id).toEqual(p.layout ? { ok: true, layout: p.layout } : { ok: true });
      expect(sameLayout(layoutFromUi(ui), p.layout)).toBe(true);
    }
  });
  it("the cleared section sends none", () => {
    expect(parse(layoutFields(NO_LAYOUT))).toEqual({ ok: true });
  });
  it("says what will happen, as an estimate from the page count", () => {
    const two = { kind: "nup", cols: 2, rows: 1 } as const;
    expect(layoutSummary(two, 4, false)).toBe("4 pages become 2 sheets");
    expect(layoutSummary(two, 4, true)).toBe("4 pages become 1 sheet");
    expect(layoutSummary(two, null, false)).toBe("Each sheet holds 2 pages.");
    expect(layoutSummary({ kind: "repeat", cols: 2, rows: 1, pages: "each" }, 3, false)).toContain("3 sheets");
    expect(layoutSummary(undefined, 4, false)).toBeNull();
  });
});
