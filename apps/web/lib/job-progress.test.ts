import { describe, expect, it } from "vitest";
import { ALLOWED_TRANSITIONS, JOB_STATES, type JobState } from "@printio/shared";
import { JOB_EVENT_TYPES } from "./job-event-labels";
import {
  JOB_PROGRESS_EVENT_STAGES,
  JOB_PROGRESS_STATUS_STAGES,
  JOB_STAGES,
  buildJobProgress,
  jobAttentionLine,
  jobListBucket,
  jobProgressPosition,
  type JobStageId,
  type JobProgressInput,
} from "./job-progress";

function stageIndex(id: JobStageId): number {
  return JOB_STAGES.indexOf(id);
}

function stageState(input: JobProgressInput, id: JobStageId) {
  return buildJobProgress(input).stages.find((s) => s.id === id)?.state;
}

/** The events a plain auto-approved job accumulates, in the order the code writes them. */
const AUTO_APPROVED_EVENTS = ["JOB_CREATED", "PDF_UPLOADED", "PREFLIGHT_COMPLETED", "POLICY_EVALUATED", "APPROVED"];

describe("stage maps stay pinned to the real state machine", () => {
  it("maps every job state in packages/shared to a stage", () => {
    for (const state of JOB_STATES) {
      expect(JOB_PROGRESS_STATUS_STAGES[state], `no stage for state ${state}`).toBeDefined();
      expect(JOB_STAGES).toContain(JOB_PROGRESS_STATUS_STAGES[state]);
    }
    expect(Object.keys(JOB_PROGRESS_STATUS_STAGES).sort()).toEqual([...JOB_STATES].sort());
  });

  it("classifies every print_job_events event type", () => {
    for (const type of JOB_EVENT_TYPES) {
      expect(JOB_PROGRESS_EVENT_STAGES, `no classification for event ${type}`).toHaveProperty(type);
    }
    expect(Object.keys(JOB_PROGRESS_EVENT_STAGES).sort()).toEqual([...JOB_EVENT_TYPES].sort());
  });

  /**
   * The stepper is only honest if it never walks backwards while the job
   * walks forwards. Every edge in ALLOWED_TRANSITIONS must therefore keep or
   * advance the stage - except the two rewind edges job-state.ts documents by
   * name (a lease expiring hands the job back to the pool; a retry re-enters
   * the lease flow), which legitimately move a job back to an earlier stage.
   */
  const DOCUMENTED_REWINDS: ReadonlyArray<readonly [JobState, JobState]> = [
    ["claimed", "approved"], // lease expired, released back to the pool
    ["failed", "claimed"], // retry
  ];

  /**
   * expired/cancelled/failed can be entered from many different points, so
   * their entry in STATUS_STAGE is only a floor - the stage actually shown is
   * the furthest one the job's own recorded events prove it reached. They are
   * checked separately below, with events, rather than on the map alone.
   */
  const HISTORY_DERIVED: readonly JobState[] = ["expired", "cancelled", "failed"];

  /** The events a job in each state has actually accumulated by then (the require-approval path). */
  const EVENTS_BY_STATE: Partial<Record<JobState, string[]>> = (() => {
    const base = ["JOB_CREATED", "PDF_UPLOADED", "PREFLIGHT_COMPLETED", "POLICY_EVALUATED"];
    const pending = [...base, "APPROVAL_REQUIRED"];
    const approved = [...pending, "APPROVED"];
    const claimed = [...approved, "AGENT_CLAIMED"];
    const downloading = [...claimed, "DOWNLOAD_STARTED"];
    const downloaded = [...downloading, "DOWNLOAD_COMPLETED"];
    const printing = [...downloaded, "PRINT_SUBMITTED"];
    const spooled = [...printing, "SPOOLER_ACCEPTED"];
    return {
      draft: ["JOB_CREATED"],
      pending_approval: pending,
      approved,
      claimed,
      downloading,
      downloaded,
      printing,
      submitted_to_spooler: spooled,
      completed: [...spooled, "JOB_COMPLETED"],
    };
  })();

  it("never moves a job backwards through the stages on an allowed forward transition", () => {
    for (const from of JOB_STATES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        if (DOCUMENTED_REWINDS.some(([f, t]) => f === from && t === to)) continue;
        if (HISTORY_DERIVED.includes(to)) continue;
        const fromIndex = stageIndex(JOB_PROGRESS_STATUS_STAGES[from]);
        const toIndex = stageIndex(JOB_PROGRESS_STATUS_STAGES[to]);
        expect(toIndex, `${from} -> ${to} moves the stepper backwards`).toBeGreaterThanOrEqual(fromIndex);
      }
    }
  });

  it("keeps a job on the stage it had reached when it expires, is cancelled, or fails", () => {
    for (const from of JOB_STATES) {
      const eventTypes = EVENTS_BY_STATE[from];
      if (!eventTypes) continue; // from-state is itself history-derived; nothing to anchor to
      for (const to of ALLOWED_TRANSITIONS[from]) {
        if (!HISTORY_DERIVED.includes(to)) continue;
        const before = buildJobProgress({ status: from, policyAction: "require_approval", eventTypes });
        const after = buildJobProgress({ status: to, policyAction: "require_approval", eventTypes });
        expect(
          stageIndex(after.currentStageId),
          `${from} -> ${to} moves the stepper backwards`,
        ).toBeGreaterThanOrEqual(stageIndex(before.currentStageId));
        expect(after.stages.find((s) => s.id === after.currentStageId)?.state).toBe("failed");
      }
    }
  });

  it("puts the terminal success state on the last stage", () => {
    expect(JOB_PROGRESS_STATUS_STAGES.completed).toBe(JOB_STAGES[JOB_STAGES.length - 1]);
  });
});

describe("buildJobProgress - a job moving normally", () => {
  it("marks earlier stages done, the live one current, and later ones upcoming", () => {
    const progress = buildJobProgress({
      status: "printing",
      policyAction: "allow",
      eventTypes: [...AUTO_APPROVED_EVENTS, "AGENT_CLAIMED", "DOWNLOAD_COMPLETED", "PRINT_SUBMITTED"],
    });
    expect(progress.currentStageId).toBe("printing");
    expect(stageState({ status: "printing", policyAction: "allow" }, "submitted")).toBe("done");
    expect(progress.stages.find((s) => s.id === "printing")?.state).toBe("current");
    expect(progress.stages.find((s) => s.id === "done")?.state).toBe("upcoming");
    expect(progress.halted).toBe(false);
    expect(progress.explanation).toBeNull();
  });

  it("marks every stage done once the job completes", () => {
    const progress = buildJobProgress({ status: "completed", policyAction: "allow" });
    expect(progress.stages.filter((s) => s.state === "current")).toHaveLength(0);
    expect(progress.stages.find((s) => s.id === "done")?.state).toBe("done");
  });

  it("shows the approval stage as skipped - not done - when the job was auto-approved", () => {
    expect(stageState({ status: "approved", policyAction: "allow" }, "approval")).toBe("skipped");
    expect(stageState({ status: "completed", policyAction: "allow" }, "approval")).toBe("skipped");
  });

  it("shows the approval stage as the current one while a job waits for a human", () => {
    const progress = buildJobProgress({ status: "pending_approval", policyAction: "require_approval" });
    expect(progress.currentStageId).toBe("approval");
    expect(progress.stages.find((s) => s.id === "approval")?.state).toBe("current");
    expect(progress.stages.find((s) => s.id === "queued")?.state).toBe("upcoming");
  });

  it("treats an approved job as waiting for a printer, not as already printing", () => {
    const progress = buildJobProgress({ status: "approved", policyAction: "require_approval" });
    expect(progress.currentStageId).toBe("queued");
    expect(progress.stages.find((s) => s.id === "approval")?.state).toBe("done");
    expect(progress.stages.find((s) => s.id === "sent")?.state).toBe("upcoming");
  });
});

/** An admin test print (app/admin/printers/actions.ts's sendTestPrintAction):
 *  the same pipeline from the upload onwards, but the policy engine, the
 *  approval queue and quota were genuinely never involved. */
const TEST_PRINT_EVENTS = ["JOB_CREATED", "PDF_UPLOADED", "PREFLIGHT_COMPLETED", "APPROVED"];

describe("buildJobProgress - an admin test print", () => {
  it("shows the print-rules stage as skipped rather than claiming it was checked", () => {
    const input: JobProgressInput = {
      status: "approved",
      policyAction: null,
      isTestPrint: true,
      eventTypes: TEST_PRINT_EVENTS,
    };
    const progress = buildJobProgress(input);
    const policy = progress.stages.find((s) => s.id === "policy");
    expect(policy?.state).toBe("skipped");
    expect(policy?.note).toMatch(/test print/i);
    expect(progress.stages.find((s) => s.id === "approval")?.state).toBe("skipped");
  });

  it("is otherwise the ordinary pipeline - same stages, same current position", () => {
    const testPrint = buildJobProgress({ status: "printing", isTestPrint: true, eventTypes: TEST_PRINT_EVENTS });
    const realJob = buildJobProgress({ status: "printing", policyAction: "allow", eventTypes: AUTO_APPROVED_EVENTS });
    expect(testPrint.currentStageId).toBe(realJob.currentStageId);
    expect(testPrint.stages.map((s) => s.id)).toEqual(realJob.stages.map((s) => s.id));
    expect(testPrint.stages.find((s) => s.id === "sent")?.state).toBe("done");
  });

  it("still reports a real failure exactly as it would for a user's job", () => {
    const progress = buildJobProgress({
      status: "failed",
      isTestPrint: true,
      errorMessage: "Windows queue 'Kyocera_Main' not found",
      attemptCount: 3,
      maxAttempts: 3,
      eventTypes: [...TEST_PRINT_EVENTS, "AGENT_CLAIMED", "PRINT_FAILED"],
    });
    expect(progress.halted).toBe(true);
    expect(progress.explanation?.lines[0]).toContain("Kyocera_Main");
  });

  it("leaves every other job untouched - the flag defaults off", () => {
    expect(stageState({ status: "approved", policyAction: "allow" }, "policy")).toBe("done");
  });
});

describe("buildJobProgress - stopped jobs say where and why", () => {
  it("fails a denied job at the print-rules stage and lists the real rule reasons", () => {
    const progress = buildJobProgress({
      status: "denied",
      policyAction: "deny",
      policyReasons: ["Color printing is not allowed for students", "37 pages exceeds the 20-page threshold"],
      eventTypes: ["JOB_CREATED", "PDF_UPLOADED", "PREFLIGHT_COMPLETED", "POLICY_EVALUATED", "DENIED"],
    });
    expect(progress.currentStageId).toBe("policy");
    expect(progress.stages.find((s) => s.id === "policy")?.state).toBe("failed");
    expect(progress.stages.find((s) => s.id === "printing")?.state).toBe("unreachable");
    expect(progress.explanation?.lines).toEqual([
      "Color printing is not allowed for students",
      "37 pages exceeds the 20-page threshold",
    ]);
  });

  it("never leaves a denial unexplained even when no reason was recorded", () => {
    const progress = buildJobProgress({ status: "denied", policyAction: "deny", policyReasons: [] });
    expect(progress.explanation?.lines[0]).toMatch(/administrator/i);
  });

  it("fails a rejected job at the approval stage and quotes the approver's reason", () => {
    const progress = buildJobProgress({
      status: "rejected",
      policyAction: "require_approval",
      rejectionReason: "Use the library printer for coursework",
    });
    expect(progress.stages.find((s) => s.id === "approval")?.state).toBe("failed");
    expect(progress.explanation?.lines).toContain("Use the library printer for coursework");
  });

  it("distinguishes expiring while waiting for approval from expiring while waiting for a printer", () => {
    const waitingForApproval = buildJobProgress({
      status: "expired",
      policyAction: "require_approval",
      eventTypes: ["JOB_CREATED", "POLICY_EVALUATED", "APPROVAL_REQUIRED"],
    });
    expect(waitingForApproval.currentStageId).toBe("approval");

    const waitingForPrinter = buildJobProgress({
      status: "expired",
      policyAction: "require_approval",
      eventTypes: ["JOB_CREATED", "POLICY_EVALUATED", "APPROVAL_REQUIRED", "APPROVED"],
    });
    expect(waitingForPrinter.currentStageId).toBe("queued");
  });

  it("puts a failure at the stage the recorded events prove the job reached", () => {
    const failedDownloading = buildJobProgress({
      status: "failed",
      policyAction: "allow",
      eventTypes: [...AUTO_APPROVED_EVENTS, "AGENT_CLAIMED", "DOWNLOAD_STARTED", "PRINT_FAILED"],
    });
    expect(failedDownloading.currentStageId).toBe("sent");

    const failedAtSpooler = buildJobProgress({
      status: "failed",
      policyAction: "allow",
      eventTypes: [...AUTO_APPROVED_EVENTS, "AGENT_CLAIMED", "DOWNLOAD_COMPLETED", "PRINT_SUBMITTED", "PRINT_FAILED"],
    });
    expect(failedAtSpooler.currentStageId).toBe("printing");
  });

  it("surfaces the agent's own error message rather than a generic failure", () => {
    const progress = buildJobProgress({
      status: "failed",
      errorMessage: "printer is offline (JOB_STATUS_OFFLINE)",
      attemptCount: 3,
      maxAttempts: 3,
    });
    expect(progress.explanation?.lines[0]).toBe("printer is offline (JOB_STATUS_OFFLINE)");
    expect(progress.explanation?.lines).toContain("Attempt 3 of 3.");
    expect(progress.retryable).toBe(false);
  });

  it("says a failure can still be retried while attempts remain, and leaves the road ahead open", () => {
    const progress = buildJobProgress({ status: "failed", errorMessage: "spooler timeout", attemptCount: 1, maxAttempts: 3 });
    expect(progress.retryable).toBe(true);
    expect(progress.stages.find((s) => s.id === "done")?.state).toBe("upcoming");
    expect(progress.explanation?.lines.some((l) => /retried/i.test(l))).toBe(true);
  });

  it("marks stages after an unrecoverable stop as unreachable, not merely upcoming", () => {
    const progress = buildJobProgress({ status: "failed", attemptCount: 3, maxAttempts: 3 });
    expect(progress.stages.find((s) => s.id === "done")?.state).toBe("unreachable");
  });
});

describe("notes", () => {
  it("gives the current stage a plain-English note for every in-flight state", () => {
    const inFlight: JobState[] = [
      "pending_approval",
      "approved",
      "claimed",
      "downloading",
      "downloaded",
      "printing",
      "submitted_to_spooler",
    ];
    for (const status of inFlight) {
      const progress = buildJobProgress({ status, policyAction: "require_approval" });
      const current = progress.stages.find((s) => s.state === "current");
      expect(current?.note, `no note for ${status}`).toBeTruthy();
      expect(current?.note).not.toMatch(/[A-Z]{2,}_/); // never an internal constant
    }
  });

  it("never claims physical pages came out of the printer", () => {
    const progress = buildJobProgress({ status: "completed" });
    const done = progress.stages.find((s) => s.id === "done");
    expect(done?.note).toMatch(/can't see the paper come out/i);
  });
});

describe("jobProgressPosition", () => {
  it("counts a step position out of the full pipeline length", () => {
    expect(jobProgressPosition(buildJobProgress({ status: "pending_approval" }))).toEqual({
      step: 3,
      total: JOB_STAGES.length,
    });
    expect(jobProgressPosition(buildJobProgress({ status: "completed" }))).toEqual({
      step: JOB_STAGES.length,
      total: JOB_STAGES.length,
    });
  });
});

describe("jobListBucket", () => {
  it("buckets every real job state, and only calls out the ones that actually went wrong", () => {
    for (const state of JOB_STATES) {
      expect(["active", "attention", "done", "other"]).toContain(jobListBucket(state));
    }
    expect(jobListBucket("completed")).toBe("done");
    expect(jobListBucket("failed")).toBe("attention");
    expect(jobListBucket("denied")).toBe("attention");
    expect(jobListBucket("rejected")).toBe("attention");
    expect(jobListBucket("expired")).toBe("attention");
    // Waiting on an approver is normal progress, not a problem to chase.
    expect(jobListBucket("pending_approval")).toBe("active");
    expect(jobListBucket("printing")).toBe("active");
    expect(jobListBucket("cancelled")).toBe("other");
  });
});

describe("jobAttentionLine", () => {
  it("prefers the agent's own error message over any generic wording", () => {
    expect(jobAttentionLine({ status: "failed", errorMessage: "Windows queue 'Kyocera_Main' not found" })).toBe(
      "Windows queue 'Kyocera_Main' not found",
    );
  });

  it("falls back to a specific sentence, never a bare 'failed', when no detail was recorded", () => {
    const line = jobAttentionLine({ status: "failed", errorMessage: "   " });
    expect(line).toBeTruthy();
    expect(line).not.toBe("Failed");
  });

  it("shows the first print-rule reason for a denied job", () => {
    expect(jobAttentionLine({ status: "denied", policyReasons: ["Over your monthly quota"] })).toBe(
      "Over your monthly quota",
    );
  });

  it("says nothing for a job that is fine", () => {
    expect(jobAttentionLine({ status: "printing" })).toBeNull();
    expect(jobAttentionLine({ status: "completed" })).toBeNull();
    expect(jobAttentionLine({ status: "pending_approval" })).toBeNull();
  });
});

describe("unknown status", () => {
  it("degrades to the first stage rather than throwing", () => {
    const progress = buildJobProgress({ status: "some_future_state" });
    expect(progress.currentStageId).toBe("submitted");
    expect(progress.explanation).toBeNull();
  });
});
