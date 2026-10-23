import { describe, expect, it } from "vitest";
import { firstName, jobMetaLine, quotaCard, statusCards, teacherEmptyText } from "./teacher-home";

const NOW = new Date("2026-03-10T12:00:00Z");

describe("firstName", () => {
  it("first word of display name", () => expect(firstName("Dana Kaplan", "d@x.com")).toBe("Dana"));
  it("falls back to the email local part", () => expect(firstName(null, "dana.k@x.com")).toBe("dana.k"));
  it("blank name uses email", () => expect(firstName("  ", "dana@x.com")).toBe("dana"));
});

describe("quotaCard", () => {
  it("is null when there is no limit", () => expect(quotaCard({ limit: null, used: 5, basis: "pdf_pages" })).toBeNull());
  it("pages basis", () =>
    expect(quotaCard({ limit: 500, used: 88, basis: "pdf_pages" })).toEqual({ label: "Pages left this month", remaining: 412, percentLeft: 82 }));
  it("sheets basis, clamps at zero", () =>
    expect(quotaCard({ limit: 100, used: 130, basis: "physical_sheets" })).toEqual({ label: "Sheets left this month", remaining: 0, percentLeft: 0 }));
  it("zero limit does not divide by zero", () => expect(quotaCard({ limit: 0, used: 0, basis: "pdf_pages" })?.percentLeft).toBe(0));
});

describe("statusCards", () => {
  it("with quota: pages left first, then printing now with waiting note", () => {
    const cards = statusCards({ quota: { label: "Pages left this month", remaining: 412, percentLeft: 80 }, printing: 1, waiting: 2 });
    expect(cards[0]).toMatchObject({ id: "quota", value: "412" });
    expect(cards[1]).toMatchObject({ id: "printing", value: "1", note: "2 waiting for approval" });
  });
  it("without quota: printing now and waiting for approval", () => {
    const cards = statusCards({ quota: null, printing: 0, waiting: 3 });
    expect(cards.map((c) => [c.id, c.value])).toEqual([
      ["printing", "0"],
      ["waiting", "3"],
    ]);
  });
});

describe("jobMetaLine", () => {
  it("pages, copies, time", () =>
    expect(jobMetaLine({ pages: 12, copies: 28, createdAt: new Date(NOW.getTime() - 3 * 60_000).toISOString() }, NOW)).toBe(
      "12 pages · 28 copies · 3 min ago",
    ));
  it("just time when size unknown", () =>
    expect(jobMetaLine({ pages: 0, copies: 0, createdAt: new Date(NOW.getTime() - 5 * 3600_000).toISOString() }, NOW)).toBe("5 h ago"));
});

it("empty text", () => expect(teacherEmptyText()).toBe("No prints yet. Tap Print to send your first one."));
