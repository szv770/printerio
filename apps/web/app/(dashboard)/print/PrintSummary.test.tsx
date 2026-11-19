import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PrintSummary, summarySentence } from "./PrintSummary";

describe("PrintSummary", () => {
  it("turns the live line into one plain sentence", () => {
    expect(summarySentence("12 pages · 2 copies · double-sided · stapled")).toBe("12 pages, 2 copies, double-sided, stapled");
    expect(summarySentence("1 copy · single-sided")).toBe("1 copy, single-sided");
  });

  it("invites a choice before a file is picked, and shows the sheet count (singular too) after", () => {
    const empty = renderToStaticMarkup(
      <PrintSummary ready={false} line="1 copy · single-sided" sheets={null}>
        <button>Print</button>
      </PrintSummary>,
    );
    expect(empty).toContain("Choose a PDF or photo to get started.");
    expect(empty).not.toContain("sheet");
    const one = renderToStaticMarkup(
      <PrintSummary ready line="1 page · 1 copy · single-sided" sheets={1}>
        <button>Print</button>
      </PrintSummary>,
    );
    expect(one.replace(/<[^>]+>/g, "")).toContain("1 page, 1 copy, single-sided");
    expect(one).toContain("1 sheet");
    expect(one).not.toContain("1 sheets");
  });
});
