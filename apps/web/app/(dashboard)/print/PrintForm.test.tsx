import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The server actions pull in server-only modules; the form only needs their names here.
vi.mock("./actions", () => ({ submitPrintJobAction: vi.fn() }));
vi.mock("./preview-action", () => ({ previewBookletAction: vi.fn() }));
vi.mock("./stage-upload-action", () => ({ createUploadSlotAction: vi.fn() }));

import { PrintForm } from "./PrintForm";

const caps = { duplex: true, color: false, staple: true, booklet: true, punch: true };
const raw = { id: "p1", label: "Kyocera", description: null, isRaw: true, declaredPaperSizes: ["letter", "11x17"], declaredCapabilities: caps, printerOnline: true };

describe("PrintForm: the quick controls (static markup, the clean start)", () => {
  const html = renderToStaticMarkup(<PrintForm printerProfiles={[raw]} maxUploadBytes={50 * 1024 * 1024} />);

  it("shows one-tap Sides, Page size, Paper type and Booklet on the main card, and starts clean", () => {
    for (const label of ["Single-sided", "Double-sided", "Letter", "Tabloid (11x17)", "Plain", "Cardstock", "Left binding", "Right binding"]) {
      expect(html, label).toContain(label);
    }
    // The clean start: single-sided, Letter, plain, no booklet.
    expect(html).toContain('<input type="hidden" name="sides" value="one"/>');
    expect(html).toContain('<input type="hidden" name="paperSize" value="letter"/>');
    expect(html).toContain('<input type="hidden" name="paperType" value="plain"/>');
    expect(html).toContain('<input type="hidden" name="booklet" value="none"/>');
  });

  it("offers the flip edge only once Double-sided is chosen, and the cardstock warning only once Cardstock is", () => {
    expect(html).not.toContain("Short edge (like a notepad)");
    expect(html).not.toContain("Uses the bypass tray");
  });

  it("nothing is greyed out because of another choice", () => {
    expect(html).not.toMatch(/aria-disabled="true"/);
    expect(html).not.toMatch(/because a booklet/i);
  });

  it("a printer that does not declare 11x17 shows no Tabloid choice, and a Windows queue shows no paper type", () => {
    const queue = { ...raw, isRaw: false, declaredPaperSizes: ["letter"] };
    const q = renderToStaticMarkup(<PrintForm printerProfiles={[queue]} maxUploadBytes={50 * 1024 * 1024} />);
    expect(q).not.toContain("Tabloid (11x17)");
    expect(q).not.toContain("Cardstock");
    expect(q).toContain("Single-sided");
  });

  it("shows Quick settings (none selected at the clean start), the Layout section, and accepts photos", () => {
    expect(html).toContain("Quick settings");
    for (const label of ["Booklet - right edge, stapled", "2 pages per sheet", "4 pages per sheet", "Same page twice per sheet (cut in half)"]) expect(html, label).toContain(label);
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain("Pages per sheet");
    expect(html).toContain("Repeat each page on the sheet");
    expect(html).toContain('<input type="hidden" name="layoutMode" value="none"/>');
    expect(html).toContain("image/jpeg,image/png");
  });

  it("a printer without booklet support offers no booklet quick settings", () => {
    const nb = { ...raw, declaredCapabilities: { ...caps, booklet: false } };
    const h = renderToStaticMarkup(<PrintForm printerProfiles={[nb]} maxUploadBytes={50 * 1024 * 1024} />);
    expect(h).not.toContain("Booklet - right edge, stapled");
    expect(h).toContain("2 pages per sheet");
  });
});
