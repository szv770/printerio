import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { preparingCards } from "./my-jobs";

const p = (name: string) => ({ finish: { originalFileName: name } });
describe("preparingCards", () => {
  it("lists waiting, asking and failed files; hides finished and cancelled ones", () => {
    const rows = [
      { id: "1", status: "queued", params: p("a.pdf"), result: null },
      { id: "2", status: "done", params: p("b.pdf"), result: { printJobId: "j" } },
      { id: "3", status: "cancelled", params: p("c.pdf"), result: null },
      { id: "4", status: "done", params: p("d.pdf"), result: { needsBookletConfirm: { sourcePages: 5, paddedPages: 8, blankPagesAdded: 3 } } },
      { id: "5", status: "failed", params: p("e.pdf"), result: { error: "expired" } },
    ];
    expect(preparingCards(rows)).toEqual([
      { id: "1", fileName: "a.pdf", state: "preparing" },
      { id: "4", fileName: "d.pdf", state: "needs_booklet_confirm" },
      { id: "5", fileName: "e.pdf", state: "failed" },
    ]);
  });
});
