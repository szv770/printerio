import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PagePicker } from "./PagePicker";

const bytes = new ArrayBuffer(8);

describe("PagePicker", () => {
  it("shows one tappable tile per page, the quick choices, and how many are chosen", () => {
    const html = renderToStaticMarkup(<PagePicker bytes={bytes} totalPages={6} value="2-3" onChange={() => undefined} />);
    for (let n = 1; n <= 6; n++) expect(html).toContain(`aria-label="Page ${n}"`);
    expect(html).not.toContain('aria-label="Page 7"');
    for (const label of ["All", "First page", "Last 3", "Odd", "Even", "Swap", "Clear"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain("2 of 6 pages chosen.");
  });

  it("marks exactly the typed pages as chosen (typing and tapping agree)", () => {
    const html = renderToStaticMarkup(<PagePicker bytes={bytes} totalPages={5} value="1, 4-5" onChange={() => undefined} />);
    const pressed = [...html.matchAll(/aria-pressed="true" aria-label="Page (\d+)"/g)].map((m) => Number(m[1]));
    expect(pressed).toEqual([1, 4, 5]);
  });

  it("says what to do when nothing is chosen yet", () => {
    const html = renderToStaticMarkup(<PagePicker bytes={bytes} totalPages={3} value="" onChange={() => undefined} />);
    expect(html).toContain("No pages chosen. Tap the pages you want.");
  });
});
