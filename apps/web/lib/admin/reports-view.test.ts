import { describe, it, expect } from "vitest";
import {
  REPORT_ROW_LIMIT,
  REPORT_RANGES,
  auditActionLabel,
  auditDetails,
  parseReportRange,
  rangeSinceIso,
  storageMeter,
  truncationNote,
} from "./reports-view";

describe("parseReportRange", () => {
  it("defaults to 30 days", () => {
    expect(parseReportRange(undefined)).toBe(30);
    expect(parseReportRange("5")).toBe(30);
  });
  it("accepts the pill values", () => {
    expect(parseReportRange("7")).toBe(7);
    expect(parseReportRange("90")).toBe(90);
    expect(parseReportRange(["7", "90"])).toBe(7);
  });
  it("has friendly pill labels", () => {
    expect(REPORT_RANGES.map((r) => r.label)).toEqual(["Last 7 days", "Last 30 days", "Last 90 days"]);
  });
});

describe("rangeSinceIso", () => {
  it("goes back whole days from now", () => {
    expect(rangeSinceIso(7, new Date("2026-03-10T12:00:00.000Z"))).toBe("2026-03-03T12:00:00.000Z");
  });
});

describe("truncationNote", () => {
  it("is silent when everything fit", () => {
    expect(truncationNote(999, REPORT_ROW_LIMIT)).toBeNull();
    expect(REPORT_ROW_LIMIT).toBe(1000);
  });
  it("says so when the limit was hit", () => {
    expect(truncationNote(1000, 1000)).toBe("Showing the first 1,000 rows");
    expect(truncationNote(200, 200, "latest")).toBe("Showing the latest 200 rows");
  });
});

describe("auditActionLabel", () => {
  it("knows the common actions", () => {
    expect(auditActionLabel("member.role_changed")).toBe("Changed someone's role");
    expect(auditActionLabel("storage.cleanup_run")).toBe("Cleaned up stored files");
  });
  it("makes the rest readable", () => {
    expect(auditActionLabel("thing.was_done")).toBe("Thing was done");
  });
});

describe("auditDetails", () => {
  it("turns metadata into label and value pairs", () => {
    expect(auditDetails({ filesDeleted: 4, role: "student", ok: true })).toEqual([
      { label: "Files deleted", value: "4" },
      { label: "Role", value: "User" },
      { label: "Ok", value: "Yes" },
    ]);
  });
  it("copes with nothing or non-objects", () => {
    expect(auditDetails(null)).toEqual([]);
    expect(auditDetails("x")).toEqual([]);
    expect(auditDetails({})).toEqual([]);
  });
  it("flattens nested values to short text", () => {
    expect(auditDetails({ ids: ["a", "b"], extra: { a: 1 } })).toEqual([
      { label: "Ids", value: "a, b" },
      { label: "Extra", value: "a: 1" },
    ]);
  });
});

describe("storageMeter", () => {
  it("splits the bar by share and adds up to the whole", () => {
    const m = storageMeter({ active: 100, withinRetention: 300, cleanable: 600 });
    expect(m.total).toBe(1000);
    expect(m.segments.map((s) => s.key)).toEqual(["active", "kept", "cleanable"]);
    expect(m.segments.map((s) => s.pct)).toEqual([10, 30, 60]);
  });
  it("is empty with no files", () => {
    expect(storageMeter({ active: 0, withinRetention: 0, cleanable: 0 }).segments.every((s) => s.pct === 0)).toBe(true);
  });
});
