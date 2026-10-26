import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The server action pulls in server-only modules; the screen only needs its name here.
vi.mock("@/app/(dashboard)/print/import-link-action", () => ({ importLinkAction: vi.fn() }));

import { LinkImport } from "./LinkImport";

describe("LinkImport", () => {
  it("starts as one quiet button, so the Print page is not busier for the people who see it", () => {
    const html = renderToStaticMarkup(<LinkImport maxUploadBytes={50 * 1024 * 1024} />);
    expect(html).toContain("Print from a link instead");
    expect(html).not.toContain("Link to a PDF");
    expect(html).not.toContain("<input");
  });
});
