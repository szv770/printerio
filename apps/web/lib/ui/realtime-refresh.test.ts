import { describe, expect, it } from "vitest";
import { affectsApprovalQueue } from "./realtime-refresh";

const shown = new Set(["j1"]);

describe("affectsApprovalQueue", () => {
  it("true when a job enters pending_approval", () => {
    expect(affectsApprovalQueue({ eventType: "INSERT", new: { id: "j2", status: "pending_approval" } }, shown)).toBe(true);
  });
  it("true when a shown job changes or is deleted (it left the queue)", () => {
    expect(affectsApprovalQueue({ eventType: "UPDATE", new: { id: "j1", status: "approved" }, old: { id: "j1" } }, shown)).toBe(true);
    expect(affectsApprovalQueue({ eventType: "DELETE", old: { id: "j1" } }, shown)).toBe(true);
  });
  it("false for unrelated jobs", () => {
    expect(affectsApprovalQueue({ eventType: "UPDATE", new: { id: "j9", status: "printing" }, old: { id: "j9" } }, shown)).toBe(false);
    expect(affectsApprovalQueue({ eventType: "INSERT", new: { id: "j8", status: "queued" } }, shown)).toBe(false);
  });
});
