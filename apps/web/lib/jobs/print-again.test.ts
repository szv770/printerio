import { describe, expect, it } from "vitest";
import {
  PRINT_AGAIN_NOT_FOUND_MESSAGE,
  PRINT_AGAIN_PURGED_MESSAGE,
  formChoicesFromJob,
  paperSizeForForm,
  pipelineSettingsFromJob,
  printAgainBanner,
  resolvePrintAgain,
  type PrintAgainJob,
} from "./print-again";

const viewer = { userId: "u1", role: "staff", organizationId: "org1" };

const job = (over: Partial<PrintAgainJob> = {}): PrintAgainJob => ({
  id: "j1",
  organization_id: "org1",
  created_by: "u1",
  original_file_name: "Parsha sheet.pdf",
  original_file_path: "org/org1/jobs/j1/original.pdf",
  derived_file_path: "org/org1/jobs/j1/derived.pdf",
  files_purged_at: null,
  source_pdf_pages: 6,
  copies: 2,
  duplex: true,
  color_mode: "bw",
  paper_size: "letter",
  finishing: { staple: false, booklet: false, punch: false },
  staple_position: null,
  booklet_binding_side: null,
  page_range: null,
  printer_profile_id: "p1",
  ...over,
});

describe("resolvePrintAgain: who may use a job and when", () => {
  it("opens the person's own job with its file, choices and banner", () => {
    const r = resolvePrintAgain(job(), viewer);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.fileName).toBe("Parsha sheet.pdf");
    expect(r.filePath).toBe("org/org1/jobs/j1/original.pdf");
    expect(r.choices.copies).toBe(2);
    expect(r.banner).toBe("Printing again: Parsha sheet.pdf. Same settings as last time (6 pages · 2 copies · double-sided). Change anything below.");
  });

  it("refuses another organization's job", () => {
    expect(resolvePrintAgain(job({ organization_id: "org2" }), viewer)).toEqual({ kind: "not_found", message: PRINT_AGAIN_NOT_FOUND_MESSAGE });
  });

  it("an admin or approver can print again any job in their own organization (owner ask 2026-11-16)", () => {
    expect(resolvePrintAgain(job({ created_by: "u2" }), { ...viewer, role: "org_admin" }).kind).toBe("ok");
    expect(resolvePrintAgain(job({ created_by: "u2" }), { ...viewer, role: "approver" }).kind).toBe("ok");
  });

  it("a plain member still cannot use a colleague's job", () => {
    expect(resolvePrintAgain(job({ created_by: "u2" }), { ...viewer, role: "staff" }).kind).toBe("not_found");
  });

  it("an admin of another organization still gets nothing", () => {
    expect(resolvePrintAgain(job({ organization_id: "org2", created_by: "u2" }), { ...viewer, role: "org_admin" }).kind).toBe("not_found");
  });

  it("refuses someone with no membership", () => {
    expect(resolvePrintAgain(job(), { userId: "u1", role: null, organizationId: null }).kind).toBe("not_found");
  });

  it("says plainly the file was removed when it was purged", () => {
    expect(resolvePrintAgain(job({ files_purged_at: "2026-11-01T00:00:00Z" }), viewer)).toEqual({ kind: "purged", message: PRINT_AGAIN_PURGED_MESSAGE });
    expect(PRINT_AGAIN_PURGED_MESSAGE).toBe("The file was removed after a few days, upload it again.");
  });

  it("treats a row with no stored path as removed", () => {
    expect(resolvePrintAgain(job({ original_file_path: null }), viewer).kind).toBe("purged");
  });

  it("a missing job (hidden by row-level security, or a made-up id) is 'not found', never a throw", () => {
    expect(resolvePrintAgain(null, viewer)).toEqual({ kind: "not_found", message: PRINT_AGAIN_NOT_FOUND_MESSAGE });
    expect(resolvePrintAgain(undefined, viewer).kind).toBe("not_found");
  });
});

describe("formChoicesFromJob: every choice the job used", () => {
  it("a plain double-sided job", () => {
    expect(formChoicesFromJob(job())).toEqual({
      profileId: "p1",
      sides: "two",
      flip: null,
      paper: "plain",
      staple: "none",
      booklet: "none",
      copies: 2,
      punch: false,
      pageRange: "",
      colorMode: "bw",
      paperSize: "letter",
      bookletFit: "fill",
      bookletSheet: "letter",
    });
  });

  it("a cardstock job comes back as cardstock (and every older job as plain)", () => {
    const withCard = job({ finishing: { staple: false, booklet: false, punch: false, paperType: "cardstock" } });
    expect(formChoicesFromJob(withCard).paper).toBe("cardstock");
    expect(pipelineSettingsFromJob(withCard).choices.paper).toBe("cardstock");
    expect(printAgainBanner(withCard)).toContain("cardstock");
    expect(formChoicesFromJob(job({ finishing: { staple: false, booklet: false, punch: false, paperType: "plain" } })).paper).toBe("plain");
    expect(formChoicesFromJob(job({ finishing: null })).paper).toBe("plain");
    expect("paper" in pipelineSettingsFromJob(job()).choices).toBe(false);
    // A cardstock note on a booklet row can not happen, but if it does the booklet wins (a booklet is never cardstock).
    expect(pipelineSettingsFromJob(job({ finishing: { staple: false, booklet: true, punch: false, paperType: "cardstock" }, booklet_binding_side: "left" })).choices.paper).toBeUndefined();
  });

  it("a single-sided, colour, stapled (top-right), punched job", () => {
    const c = formChoicesFromJob(
      job({ duplex: false, color_mode: "color", finishing: { staple: true, booklet: false, punch: true }, staple_position: "top-right", paper_size: "legal" }),
    );
    expect(c).toMatchObject({ sides: "one", colorMode: "color", staple: "top-right", punch: true, paperSize: "legal" });
  });

  it("two staples on the left", () => {
    const c = formChoicesFromJob(job({ duplex: false, finishing: { staple: true, booklet: false, punch: false, stapleStyle: "dual-left" }, staple_position: "top-left" }));
    expect(c.staple).toBe("dual-left");
  });

  it("a booklet job: side, fit and sheet, always double-sided", () => {
    const c = formChoicesFromJob(
      job({
        duplex: true,
        finishing: { staple: false, booklet: true, punch: false, bookletFit: "keep" },
        booklet_binding_side: "right",
        paper_size: "letter",
      }),
    );
    expect(c).toMatchObject({ booklet: "right", sides: "two", bookletFit: "keep", bookletSheet: "letter", flip: null });
    const tab = formChoicesFromJob(job({ finishing: { staple: false, booklet: true, punch: false, bookletFit: "fill", bookletSheet: "tabloid" }, booklet_binding_side: "left", paper_size: "tabloid" }));
    expect(tab).toMatchObject({ booklet: "left", bookletSheet: "tabloid" });
  });

  it("a short-edge (notepad) flip job", () => {
    const c = formChoicesFromJob(job({ finishing: { staple: false, booklet: false, punch: false, duplexEdge: "short" } }));
    expect(c).toMatchObject({ sides: "two", flip: "short" });
  });

  it("ignores a short-edge note on a single-sided job or a booklet", () => {
    expect(formChoicesFromJob(job({ duplex: false, finishing: { staple: false, booklet: false, punch: false, duplexEdge: "short" } })).flip).toBeNull();
    expect(formChoicesFromJob(job({ finishing: { staple: false, booklet: true, punch: false, duplexEdge: "short" }, booklet_binding_side: "left" })).flip).toBeNull();
  });

  it("keeps the page range text", () => {
    expect(formChoicesFromJob(job({ page_range: "1-3, 5", source_pdf_pages: 4 })).pageRange).toBe("1-3, 5");
  });

  it("an older job that never stored a corner or binding side gets the usual top-left / left in the form", () => {
    expect(formChoicesFromJob(job({ finishing: { staple: true, booklet: false, punch: false } })).staple).toBe("top-left");
    expect(formChoicesFromJob(job({ finishing: { staple: false, booklet: true, punch: false } })).booklet).toBe("left");
  });

  it("survives junk or missing finishing JSON", () => {
    expect(formChoicesFromJob(job({ finishing: null })).staple).toBe("none");
    expect(formChoicesFromJob(job({ finishing: "x" })).booklet).toBe("none");
  });
});

describe("pipelineSettingsFromJob: what reprintJobAction re-runs", () => {
  it("carries the short-edge flip", () => {
    expect(pipelineSettingsFromJob(job({ finishing: { staple: false, booklet: false, punch: false, duplexEdge: "short" } })).choices.flip).toBe("short");
    expect(pipelineSettingsFromJob(job()).choices.flip).toBeUndefined();
  });

  it("carries staple corner, two-staple style, punch, booklet side / fit / sheet, range, colour", () => {
    const s = pipelineSettingsFromJob(
      job({ duplex: false, color_mode: "color", finishing: { staple: true, booklet: false, punch: true, stapleStyle: "dual-left" }, page_range: "2-4", source_pdf_pages: 3 }),
    );
    expect(s.choices).toEqual({ sides: "one", staple: "dual-left", booklet: "none", copies: 2, punch: true, pageRange: "2-4" });
    expect(s.colorMode).toBe("color");
    expect(s.punch).toBe(true);
    const b = pipelineSettingsFromJob(job({ finishing: { staple: false, booklet: true, punch: false, bookletFit: "keep", bookletSheet: "tabloid" }, booklet_binding_side: "right", paper_size: "tabloid" }));
    expect(b.choices.booklet).toBe("right");
    expect(b.bookletFit).toBe("keep");
    expect(b.bookletSheet).toBe("tabloid");
  });

  it("an older job with no stored corner / side falls back to the printer's own default ('profile')", () => {
    const s = pipelineSettingsFromJob(job({ finishing: { staple: true, booklet: false, punch: false } }));
    expect(s.choices.staple).toBe("profile");
    expect(pipelineSettingsFromJob(job({ finishing: { staple: false, booklet: true, punch: false } })).choices.booklet).toBe("profile");
  });

  it("hands 11x17 to the pipeline under its own name (stored jobs call it 'tabloid')", () => {
    expect(pipelineSettingsFromJob(job({ paper_size: "tabloid" })).paperSize).toBe("11x17");
    expect(pipelineSettingsFromJob(job({ paper_size: "letter" })).paperSize).toBe("letter");
  });
});

describe("paperSizeForForm", () => {
  it("picks the spelling the printer declares", () => {
    expect(paperSizeForForm("tabloid", ["letter", "11x17"])).toBe("11x17");
    expect(paperSizeForForm("tabloid", ["letter", "tabloid"])).toBe("tabloid");
    expect(paperSizeForForm("letter", ["letter", "11x17"])).toBe("letter");
  });
});

describe("printAgainBanner", () => {
  const text = (j: PrintAgainJob) => printAgainBanner(j);

  it("says what was used in plain words", () => {
    expect(text(job({ duplex: false, copies: 1, finishing: { staple: true, booklet: false, punch: false }, staple_position: "top-left" }))).toBe(
      "Printing again: Parsha sheet.pdf. Same settings as last time (6 pages · 1 copy · single-sided · stapled top-left). Change anything below.",
    );
  });

  it("mentions a page range", () => {
    expect(text(job({ page_range: "1-5, 8", source_pdf_pages: 6 }))).toContain("only pages 1-5, 8");
  });

  it("mentions the short-edge flip", () => {
    expect(text(job({ finishing: { staple: false, booklet: false, punch: false, duplexEdge: "short" } }))).toContain("flips on the short edge");
  });

  it("mentions a booklet's binding side and sheet", () => {
    const t = text(job({ finishing: { staple: false, booklet: true, punch: false, bookletSheet: "tabloid" }, booklet_binding_side: "right", paper_size: "tabloid" }));
    expect(t).toContain("booklet");
    expect(t).toContain("bound on the right");
    expect(t).toContain("11x17 sheet");
  });

  it("mentions colour", () => {
    expect(text(job({ color_mode: "color" }))).toContain("color");
  });
});
