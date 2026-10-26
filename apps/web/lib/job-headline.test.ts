import { describe, expect, it } from "vitest";
import { jobHeadline } from "./job-headline";
import { JOB_STATES } from "@printio/shared";

describe("jobHeadline", () => {
  it("gives every real state a short plain sentence", () => {
    for (const s of JOB_STATES) {
      const h = jobHeadline(s);
      expect(h.sentence.length).toBeGreaterThan(3);
      expect(h.sentence.length).toBeLessThan(40);
    }
  });
  it("says printing now while it prints", () => {
    expect(jobHeadline("printing")).toMatchObject({ sentence: "Printing now", tone: "live" });
    expect(jobHeadline("submitted_to_spooler").tone).toBe("live");
  });
  it("marks done as success and failed as danger", () => {
    expect(jobHeadline("completed")).toMatchObject({ sentence: "Sent to the printer", tone: "success", detail: expect.stringMatching(/few moments.*start printing/i) });
    expect(jobHeadline("failed")).toMatchObject({ sentence: "It didn't print", tone: "danger" });
  });
  it("marks people-waiting states as warning", () => {
    expect(jobHeadline("pending_approval").tone).toBe("warning");
    expect(jobHeadline("held").tone).toBe("warning");
  });
  it("falls back for unknown states", () => {
    expect(jobHeadline("wat")).toEqual({ sentence: "Status unknown", tone: "neutral" });
  });
});
