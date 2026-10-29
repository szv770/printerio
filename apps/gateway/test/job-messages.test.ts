import { describe, expect, it } from "vitest";
import { JOB_STATES } from "@printio/shared";
import { describeJob } from "../src/job-messages.js";

// Held reasons exactly as apps/web/lib/gateway/ipp-choices.ts words them.
const HELD = {
  booklet: "Booklet: choose left or right binding.",
  shortEdge: "Flip on the short edge is not available from the print dialog yet; choose double-sided or use the website.",
  paper: "Paper size A4 is not available yet; only Letter can be printed from the print dialog. Use the website for other sizes.",
  copies: "The number of copies must be 1 to 99, so nothing was printed. Choose the copies again on the website.",
  pages: "The page range from the print dialog could not be read, so nothing was printed. Choose the pages again on the website.",
  pagesGone: "The pages you chose in the print dialog could not be used.",
  sides: 'Printio does not recognise the sides setting "weird", so nothing was printed. Choose single-sided or double-sided on the website.',
  twoStaples: "The print dialog asked for more than one staple position, so nothing was printed. Choose one corner on the website.",
  bookletStaple: "A booklet is stapled for you, so it cannot also be stapled in a corner. Choose either a booklet or a staple.",
  stapleCorner: "The staple corner is only checked on portrait pages, so nothing was printed. Choose the staple on the website.",
};

describe("describeJob: state -> (job-state, reasons, message)", () => {
  const table: [string, string | undefined, number, string, string][] = [
    ["approved", undefined, 3, "job-queued", "Waiting for the printer"],
    ["claimed", undefined, 3, "job-queued", "Waiting for the printer"],
    ["downloading", undefined, 3, "job-queued", "Waiting for the printer"],
    ["downloaded", undefined, 3, "job-queued", "Waiting for the printer"],
    ["printing", undefined, 5, "job-printing", "Printing"],
    ["submitted_to_spooler", undefined, 5, "job-printing", "Printing"],
    ["completed", undefined, 9, "job-completed-successfully", "Sent to the printer. It may take a few moments to start printing."],
    ["pending_approval", "Waiting for approval before it prints.", 4, "job-hold-until-specified", "Waiting for approval in Printio"],
    ["cancelled", undefined, 7, "job-canceled-by-user", "Cancelled"],
    ["rejected", "An approver declined this job.", 8, "aborted-by-system", "An approver declined this job in Printio"],
    ["expired", undefined, 8, "aborted-by-system", "This job waited too long and was cancelled"],
    ["failed", "ERR_SPOOLER 0x80070005 access denied", 8, "aborted-by-system", "The printer could not print this job. Open Printio > My jobs for details"],
    ["failed", undefined, 8, "aborted-by-system", "The printer could not print this job. Open Printio > My jobs for details"],
    ["denied", "Color printing is not allowed for your group.", 8, "aborted-by-system", "Color printing is not allowed for your group."],
    ["denied", undefined, 8, "aborted-by-system", "Your organization's print rules do not allow this job"],
    ["draft", undefined, 4, "job-hold-until-specified", "Printio is getting this job ready"],
    ["held", HELD.booklet, 4, "job-hold-until-specified", "Open Printio > My jobs to choose Left or Right binding"],
    ["held", HELD.shortEdge, 4, "job-hold-until-specified", "Flip on the short edge is not supported. Open Printio > My jobs to choose another"],
    ["held", HELD.paper, 4, "job-hold-until-specified", "This paper size is not supported. Open Printio > My jobs to choose Letter or Ledger (11x17)"],
    ["held", HELD.copies, 4, "job-hold-until-specified", "The number of copies is not supported. Open Printio > My jobs to choose again"],
    ["held", HELD.pages, 4, "job-hold-until-specified", "The page range could not be used. Open Printio > My jobs to choose the pages"],
    ["held", HELD.pagesGone, 4, "job-hold-until-specified", "The page range could not be used. Open Printio > My jobs to choose the pages"],
    ["held", HELD.sides, 4, "job-hold-until-specified", "That double-sided setting is not supported. Open Printio > My jobs to choose again"],
    ["held", HELD.twoStaples, 4, "job-hold-until-specified", "That finishing is not supported. Open Printio > My jobs to choose again"],
    ["held", HELD.bookletStaple, 4, "job-hold-until-specified", "That finishing is not supported. Open Printio > My jobs to choose again"],
    ["held", HELD.stapleCorner, 4, "job-hold-until-specified", "That finishing is not supported. Open Printio > My jobs to choose again"],
    ["held", undefined, 4, "job-hold-until-specified", "Open Printio > My jobs to choose how to print this"],
    ["held", "Something nobody has worded yet.", 4, "job-hold-until-specified", "Open Printio > My jobs to choose how to print this"],
  ];
  for (const [state, web, ippState, reason, message] of table) {
    it(`${state} (${(web ?? "no text").slice(0, 28)}) -> ${ippState} ${reason}: ${message}`, () => {
      const d = describeJob(state as never, web);
      expect(d.state).toBe(ippState);
      expect(d.reasons).toEqual([reason]);
      expect(d.message).toBe(message);
    });
  }

  it("several different problems at once -> one generic, still actionable message", () => {
    const d = describeJob("held", `${HELD.paper} ${HELD.booklet}`);
    expect(d.state).toBe(4);
    expect(d.message).toBe("Some print options need your choice. Open Printio > My jobs to finish them");
  });

  it("a state this gateway does not know is held, never done", () => {
    const d = describeJob("something_new" as never, undefined);
    expect(d.state).toBe(4);
    expect(d.message).toBe("Open Printio > My jobs to see this job");
  });

  it("no state yet (waiting for the document of a Create-Job) is pending-held 'job-incoming'", () => {
    const d = describeJob(undefined, undefined);
    expect([d.state, d.reasons]).toEqual([4, ["job-incoming"]]);
    expect(d.message).toBe("Waiting for the document to arrive");
  });

  it("every JobState has a short plain message (< 100 chars) with no raw ids or jargon", () => {
    for (const s of JOB_STATES) {
      const m = describeJob(s, undefined).message;
      expect(m.length, s).toBeGreaterThan(0);
      expect(m.length, s).toBeLessThan(100);
      expect(m, s).not.toMatch(/spooler|lease|claimed|0x|_/i);
    }
  });

  it("a long policy reason is cut under 100 characters", () => {
    const d = describeJob("denied", "x".repeat(300));
    expect(d.message.length).toBeLessThan(100);
  });
});

describe("describeJob: waiting for the printer (queued, not failed)", () => {
  it("tells the phone why when the web app knows: still 'pending', never aborted, under 100 characters", () => {
    const off = describeJob("approved", "ignored", "unavailable");
    expect(off).toMatchObject({ state: 3, reasons: ["job-queued"], message: "Waiting for the printer - it is off or offline" });
    const unknown = describeJob("approved", "ignored", "unknown");
    expect(unknown).toMatchObject({ state: 3, reasons: ["job-queued"], message: "Waiting for the printer - status unknown" });
    expect(describeJob("claimed", undefined, "unavailable").state).toBe(3);
    for (const d of [off, unknown]) expect(d.message.length).toBeLessThan(100);
  });
  it("without a waiting kind it is exactly the old wording", () => {
    expect(describeJob("approved").message).toBe("Waiting for the printer");
    expect(describeJob("approved", "some text").message).toBe("Waiting for the printer");
  });
  it("the waiting kind is ignored for any other state", () => {
    expect(describeJob("printing", undefined, "unavailable").message).toBe("Printing");
    expect(describeJob("failed", undefined, "unavailable").state).toBe(8);
  });
});
