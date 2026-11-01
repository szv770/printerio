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

describe("jobHeadline: printer attention", () => {
  it("a failed job carrying the printer-attention marker says so in the printer's words", () => {
    const h = jobHeadline("failed", "[printio:printer-error v1 code=40022] Paper jam");
    expect(h).toMatchObject({ sentence: "The printer needs attention", tone: "danger" });
    expect(h.detail).toMatch(/^Paper jam\. .*may still print/);
  });
  it("the marker only counts on a failed job; other failures keep the old headline", () => {
    expect(jobHeadline("completed", "[printio:printer-error v1 code=1] x").sentence).toBe("Sent to the printer");
    expect(jobHeadline("failed", "raw print: boom")).toMatchObject({ sentence: "It didn't print" });
  });
});
