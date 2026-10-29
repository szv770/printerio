import { describe, expect, it } from "vitest";
import { printerStatusLabel, printerSaysLine } from "./status-label";

describe("printerStatusLabel (one short word or phrase per printer, for lists)", () => {
  it("says Ready when it is working normally", () => {
    expect(printerStatusLabel("online", "Ready")).toEqual({ label: "Ready", tone: "success" });
    expect(printerStatusLabel("online", null)).toEqual({ label: "Ready", tone: "success" });
  });
  it("shows the printer's own words when it needs someone, or a plain phrase when it says nothing", () => {
    expect(printerStatusLabel("error", "Add paper in cassette 2")).toEqual({ label: "Add paper in cassette 2", tone: "warning" });
    expect(printerStatusLabel("error", null)).toEqual({ label: "Needs attention", tone: "warning" });
  });
  it("offline and not yet known stay plain", () => {
    expect(printerStatusLabel("offline", "Printio cannot reach the printer")).toEqual({ label: "Offline", tone: "neutral" });
    expect(printerStatusLabel("unknown", null)).toEqual({ label: "Status unknown", tone: "neutral" });
    expect(printerStatusLabel("anything else", null)).toEqual({ label: "Status unknown", tone: "neutral" });
  });
});

describe("printerSaysLine (what to tell someone whose job is waiting)", () => {
  it("quotes the printer when it needs attention, and says offline plainly", () => {
    expect(printerSaysLine("error", "Paper jam in the finisher")).toBe("The printer says: Paper jam in the finisher.");
    expect(printerSaysLine("error", null)).toBe("The printer needs attention.");
    expect(printerSaysLine("offline", "Printio cannot reach the printer")).toBe("Printio cannot reach the printer right now.");
  });
  it("says nothing when the printer is fine or unknown (so a normal wait is not blamed on it)", () => {
    expect(printerSaysLine("online", "Ready")).toBeNull();
    expect(printerSaysLine("unknown", null)).toBeNull();
  });
});
