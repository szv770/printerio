import { describe, expect, it } from "vitest";
import { formatWaitingMarker, gaveUpMessage, WAITING_UNAVAILABLE_TEXT, WAITING_UNKNOWN_TEXT } from "@printio/shared";
import { jobWaiting, jobWaitingLine } from "./job-waiting";
import { jobHeadline } from "./job-headline";
import { jobStatusDisplay } from "./job-status-labels";
import { buildJobProgress, jobAttentionLine, jobListBucket } from "./job-progress";
import { friendlyFailureMessage } from "./job-failure";
import { jobMessage, jobWaitingKind } from "./gateway/http";
import { buildAttentionItems, type AttentionInput } from "./home/admin-home";

const T = Date.parse("2026-10-23T10:00:00.000Z");
const unavailable = formatWaitingMarker({ since: T, tries: 2, kind: "unavailable" });
const unknown = formatWaitingMarker({ since: T, tries: 1, kind: "unknown" });

describe("jobWaiting: only a queued job carrying the marker is 'waiting'", () => {
  it("approved + marker = waiting, with the plain reason", () => {
    expect(jobWaiting("approved", unavailable)).toMatchObject({ kind: "unavailable", text: WAITING_UNAVAILABLE_TEXT });
    expect(jobWaiting("approved", unknown)).toMatchObject({ kind: "unknown", text: WAITING_UNKNOWN_TEXT });
  });
  it("claimed + marker (being retried right now) still reads as waiting", () => {
    expect(jobWaiting("claimed", unavailable)).not.toBeNull();
  });
  it("any other status, a missing marker, or an unrelated message is not waiting", () => {
    for (const s of ["downloading", "printing", "completed", "failed", "cancelled", "held", "pending_approval"]) expect(jobWaiting(s, unavailable), s).toBeNull();
    expect(jobWaiting("approved", null)).toBeNull();
    expect(jobWaiting("approved", "spooler offline")).toBeNull();
    expect(jobWaiting("approved", undefined)).toBeNull();
  });
  it("jobWaitingLine gives the reason for the list, or null", () => {
    expect(jobWaitingLine({ status: "approved", errorMessage: unavailable })).toBe(WAITING_UNAVAILABLE_TEXT);
    expect(jobWaitingLine({ status: "approved", errorMessage: null })).toBeNull();
  });
});

describe("job page headline and status badge say 'Waiting for the printer', never 'failed'", () => {
  it("headline: warning tone, with the reason as detail", () => {
    expect(jobHeadline("approved", unavailable)).toMatchObject({ sentence: "Waiting for the printer", tone: "warning", detail: WAITING_UNAVAILABLE_TEXT });
    expect(jobHeadline("approved", unknown)).toMatchObject({ sentence: "Waiting for the printer", detail: WAITING_UNKNOWN_TEXT });
  });
  it("headline for plain statuses is unchanged", () => {
    expect(jobHeadline("approved")).toEqual({ sentence: "Waiting for the printer", tone: "warning" });
    expect(jobHeadline("failed")).toEqual({ sentence: "It didn't print", tone: "danger" });
    expect(jobHeadline("printing")).toEqual({ sentence: "Printing now", tone: "live" });
  });
  it("status badge: a waiting job is a warning, not 'Approved' and not 'Failed'", () => {
    const waiting = jobStatusDisplay("approved", unavailable);
    expect(waiting.label).toBe("Waiting for the printer");
    expect(waiting.tone).toBe("warning");
    expect(jobStatusDisplay("approved").label).toBe("Approved");
    expect(jobStatusDisplay("failed").label).toBe("Failed");
  });
});

describe("progress model and list", () => {
  it("a waiting job explains itself and is not halted, not retryable-failed, not 'attention'", () => {
    const p = buildJobProgress({ status: "approved", errorMessage: unavailable, attemptCount: 0, maxAttempts: 3 });
    expect(p.halted).toBe(false);
    expect(p.explanation?.title).toBe("Waiting for the printer");
    expect(p.explanation?.lines.join(" ")).toContain(WAITING_UNAVAILABLE_TEXT);
    expect(p.explanation?.lines.join(" ")).toMatch(/cancel/i);
    expect(p.explanation?.lines.join(" ")).not.toMatch(/did not print|failed/i);
    expect(jobListBucket("approved")).toBe("active");
  });
  it("the unknown kind says 'status unknown'", () => {
    const p = buildJobProgress({ status: "approved", errorMessage: unknown });
    expect(p.explanation?.lines.join(" ")).toContain("status unknown");
  });
  it("an ordinary queued job has no explanation (unchanged)", () => {
    expect(buildJobProgress({ status: "approved" }).explanation).toBeNull();
  });
  it("jobAttentionLine stays null for a waiting job (it is not a problem to chase)", () => {
    expect(jobAttentionLine({ status: "approved", errorMessage: unavailable })).toBeNull();
  });
});

describe("failure wording", () => {
  it("a job that waited out its window shows the plain gave-up sentence, not the generic fallback", () => {
    const m = friendlyFailureMessage(gaveUpMessage(2 * 3600_000));
    expect(m).toContain("not available for 2 hours");
    expect(m).toContain("Try again");
    expect(m).not.toContain("[printio");
  });
  it("'all data was sent but the printer did not confirm' says so, and does not claim nothing was received", () => {
    const m = friendlyFailureMessage("raw print: raw print write to 10.0.0.5:9100 timed out after 120000ms (all data was sent but the printer did not confirm)");
    expect(m).toContain("did not confirm");
    expect(m).toContain("press Try again only if nothing came out");
  });
  it("a stray waiting marker on a failed job never leaks the raw marker", () => {
    const m = friendlyFailureMessage(unavailable);
    expect(m).not.toContain("[printio");
    expect(m).toContain("not available");
  });
  it("progress explanation for a gave-up job keeps the Try again button text", () => {
    const p = buildJobProgress({ status: "failed", errorMessage: gaveUpMessage(7200_000), attemptCount: 0, maxAttempts: 3 });
    expect(p.retryable).toBe(true);
    expect(p.explanation?.lines.join(" ")).toContain("not available for 2 hours");
    expect(p.explanation?.lines.join(" ")).toContain("Try again");
  });
});

describe("phone (gateway web API) message", () => {
  it("a waiting job tells the phone why, and which kind, in plain words", () => {
    expect(jobMessage({ status: "approved", errorMessage: unavailable })).toBe(WAITING_UNAVAILABLE_TEXT);
    expect(jobMessage({ status: "approved", errorMessage: unknown })).toBe(WAITING_UNKNOWN_TEXT);
    expect(jobWaitingKind({ status: "approved", errorMessage: unavailable })).toBe("unavailable");
    expect(jobWaitingKind({ status: "approved", errorMessage: unknown })).toBe("unknown");
    expect(jobWaitingKind({ status: "approved", errorMessage: null })).toBeUndefined();
    expect(jobWaitingKind({ status: "printing", errorMessage: unavailable })).toBeUndefined();
  });
  it("a plain queued job has no message (unchanged), and a failed job keeps its text", () => {
    expect(jobMessage({ status: "approved" })).toBeUndefined();
    expect(jobMessage({ status: "failed", errorMessage: gaveUpMessage(7200_000) })).toContain("not available for 2 hours");
    expect(jobMessage({ status: "failed", errorMessage: gaveUpMessage(7200_000) })).not.toContain("[printio");
  });
});

describe("Overview: waiting jobs are NOT failures", () => {
  const none: AttentionInput = {
    now: new Date(T + 60_000),
    pendingApprovals: { count: 0, oldestCreatedAt: null },
    failed: { count: 0, recent: [] },
    agents: [],
    printers: [],
    heldCount: 0,
    stuckDevices: null,
  };
  it("shows a warning 'waiting for the printer' item, not a danger 'failed' item", () => {
    const items = buildAttentionItems({ ...none, waitingForPrinter: { count: 3 } });
    expect(items.map((i) => i.id)).toEqual(["waiting"]);
    expect(items[0]).toMatchObject({ severity: "warning", title: "3 jobs are waiting for the printer" });
    expect(items.some((i) => i.id === "failed")).toBe(false);
  });
  it("singular, and nothing when none are waiting", () => {
    expect(buildAttentionItems({ ...none, waitingForPrinter: { count: 1 } })[0]?.title).toBe("1 job is waiting for the printer");
    expect(buildAttentionItems({ ...none, waitingForPrinter: { count: 0 } })).toEqual([]);
    expect(buildAttentionItems(none)).toEqual([]);
  });
  it("a job that gave up IS counted as failed, with the plain sentence", () => {
    const items = buildAttentionItems({ ...none, failed: { count: 1, recent: [{ name: "a.pdf", errorMessage: gaveUpMessage(7200_000) }] } });
    expect(items[0]).toMatchObject({ id: "failed", severity: "danger" });
    expect(items[0]?.note).toContain("not available for 2 hours");
  });
});

describe("every list that shows a status word labels a waiting job as waiting (not 'Approved')", () => {
  it("jobStatusCell: warning tone, 'Waiting for the printer'; plain approved and other statuses unchanged", async () => {
    const { jobStatusCell } = await import("./admin/all-jobs");
    expect(jobStatusCell("approved", unavailable)).toEqual({ label: "Waiting for the printer", tone: "warning" });
    expect(jobStatusCell("approved", unknown)).toEqual({ label: "Waiting for the printer", tone: "warning" });
    expect(jobStatusCell("approved", null)).toEqual({ label: "Approved", tone: "warning" });
    expect(jobStatusCell("failed", unavailable)).toEqual({ label: "Failed", tone: "danger" });
    expect(jobStatusCell("completed", null)).toEqual({ label: "Completed", tone: "success" });
  });
});
