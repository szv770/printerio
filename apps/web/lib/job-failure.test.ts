import { describe, expect, it } from "vitest";
import { friendlyFailureMessage } from "./job-failure";

describe("friendlyFailureMessage", () => {
  it("says something useful for each known agent failure", () => {
    expect(friendlyFailureMessage("spooler reported a failure status: Error, Offline")).toMatch(/printer/i);
    expect(friendlyFailureMessage('job 12 was never observed on queue "Kyocera" - could not confirm spooler acceptance')).toMatch(/could not confirm/i);
    expect(friendlyFailureMessage('timed out after 600s waiting for job 4 on queue "K" to leave the spooler')).toMatch(/took too long/i);
    expect(friendlyFailureMessage("Agent lease expired mid-operation (agent likely disconnected or crashed).")).toMatch(/computer|agent/i);
    expect(friendlyFailureMessage("agent restarted while this job was printing and it could not be resumed")).toMatch(/restarted/i);
    expect(friendlyFailureMessage("raw print: connect ECONNREFUSED 10.0.0.5:9100")).toMatch(/could not reach the printer/i);
    expect(friendlyFailureMessage("download failed: 403")).toMatch(/document/i);
  });

  it("never leaks raw text, stack traces or database errors", () => {
    const stack = "Error: boom\n    at Object.<anonymous> (C:\\agent\\x.js:1:1)";
    const out = friendlyFailureMessage(stack);
    expect(out).not.toMatch(/at Object|\.js|boom/);
    const db = friendlyFailureMessage('duplicate key value violates unique constraint "print_jobs_pkey"');
    expect(db).not.toMatch(/duplicate key|print_jobs/);
  });

  it("falls back to a plain sentence for empty or unknown input", () => {
    expect(friendlyFailureMessage(null)).toMatch(/did not print/i);
    expect(friendlyFailureMessage("   ")).toMatch(/did not print/i);
    expect(friendlyFailureMessage("some_new_code_42")).toMatch(/did not print/i);
  });
});
