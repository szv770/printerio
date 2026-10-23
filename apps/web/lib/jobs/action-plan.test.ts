import { describe, it, expect } from "vitest";
import { jobActionPlan, type JobActionInput } from "./action-plan";

const base: JobActionInput = { status: "completed", isOwner: true, isTestPrint: false, filesPurged: false, attemptCount: 1, maxAttempts: 3 };
const plan = (o: Partial<JobActionInput>) => jobActionPlan({ ...base, ...o });

describe("jobActionPlan", () => {
  it("failed with tries left: Try again + Cancel, never Print again", () => {
    const p = plan({ status: "failed", attemptCount: 1, maxAttempts: 3 });
    expect(p.retry).toBe(true);
    expect(p.cancel).toBe(true);
    expect(p.reprint).toBe(false);
    expect(p.reprintPrimary).toBe(false);
  });
  it("failed with no tries left: Print again (primary) + Cancel", () => {
    const p = plan({ status: "failed", attemptCount: 3, maxAttempts: 3 });
    expect(p.retry).toBe(false);
    expect(p.reprint).toBe(true);
    expect(p.reprintPrimary).toBe(true);
    expect(p.cancel).toBe(true);
  });
  it("failed with the file gone: neither retry nor reprint", () => {
    const p = plan({ status: "failed", filesPurged: true });
    expect(p.retry).toBe(false);
    expect(p.reprint).toBe(false);
  });
  it("completed: Print again is primary", () => {
    const p = plan({ status: "completed" });
    expect(p).toMatchObject({ retry: false, reprint: true, reprintPrimary: true, cancel: false });
  });
  it("cancelled: Print again, not primary", () => {
    const p = plan({ status: "cancelled" });
    expect(p).toMatchObject({ retry: false, reprint: true, reprintPrimary: false, cancel: false });
  });
  it("in-flight and waiting jobs only offer Cancel", () => {
    expect(plan({ status: "pending_approval" })).toMatchObject({ cancel: true, reprint: false, retry: false });
    expect(plan({ status: "approved" })).toMatchObject({ cancel: true, reprint: false });
    expect(plan({ status: "held" })).toMatchObject({ cancel: true, reprint: false });
  });
  it("at the printer: no buttons, a note", () => {
    const p = plan({ status: "printing" });
    expect(p).toMatchObject({ atPrinter: true, cancel: false, reprint: false, retry: false });
  });
  it("is empty for someone who is not the owner", () => {
    expect(plan({ status: "failed", isOwner: false })).toMatchObject({ retry: false, reprint: false, cancel: false, atPrinter: false });
  });
  it("never offers Print again for a test print", () => {
    expect(plan({ status: "completed", isTestPrint: true }).reprint).toBe(false);
  });
});
