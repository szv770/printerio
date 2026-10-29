// What an IPP client (Android wPrint/CUPS, Windows) is told about a job: IPP job-state, job-state-reasons and a short,
// plain-English `job-state-message` (also used as the Print-Job / Send-Document `status-message`).
// State mapping follows docs/superpowers/specs/2026-10-22-gateway-contract.md; the wording is ours so it can stay short
// (< 100 chars) and say "Printio" wherever the person has to act. The web app's own text (held reason, first policy
// reason) is only used to tell WHICH problem it is, or, for a policy refusal, shown as written (trimmed).
import type { JobState } from "@printio/shared";

export const IPP_JOB_STATE = { pending: 3, pendingHeld: 4, processing: 5, canceled: 7, aborted: 8, completed: 9 } as const;

export interface JobDescription {
  state: number;
  /** IPP job-state-reasons keywords. */
  reasons: string[];
  /** IPP text for job-state-message / status-message. */
  message: string;
}

const MAX_MESSAGE = 99;
const HOLD = "job-hold-until-specified";
const ACT = "Open Printio > My jobs";

const trim = (s: string): string => (s.length <= MAX_MESSAGE ? s : `${s.slice(0, MAX_MESSAGE - 3).trimEnd()}...`);

/** The kinds of problem a held print-dialog job can have (wording from apps/web/lib/gateway/ipp-choices.ts). */
const HELD_KINDS: { test: RegExp; message: string }[] = [
  { test: /choose left or right binding/i, message: `${ACT} to choose Left or Right binding` },
  { test: /short edge/i, message: `Flip on the short edge is not supported. ${ACT} to choose another` },
  { test: /paper size/i, message: `This paper size is not supported. ${ACT} to choose Letter or Ledger (11x17)` },
  { test: /number of copies/i, message: `The number of copies is not supported. ${ACT} to choose again` },
  { test: /page range|pages you chose/i, message: `The page range could not be used. ${ACT} to choose the pages` },
  { test: /sides setting/i, message: `That double-sided setting is not supported. ${ACT} to choose again` },
  { test: /staple|finishing|booklet/i, message: `That finishing is not supported. ${ACT} to choose again` },
];

function describeHeld(webMessage: string | undefined): string {
  // Sentence by sentence, so one reason's wording can never be mistaken for another's.
  const sentences = (webMessage ?? "").split(/(?<=[.!?])\s+/).filter(Boolean);
  const found = new Set<number>();
  for (const sentence of sentences) {
    const i = HELD_KINDS.findIndex((k) => k.test.test(sentence));
    if (i >= 0) found.add(i);
  }
  if (found.size === 1) return (HELD_KINDS[[...found][0] as number] as { message: string }).message;
  if (found.size > 1) return `Some print options need your choice. ${ACT} to finish them`;
  return `${ACT} to choose how to print this`;
}

/** `state` is undefined while a Create-Job is still waiting for its document. Never throws. */
export function describeJob(state: JobState | undefined, webMessage?: string, waiting?: "unavailable" | "unknown"): JobDescription {
  if (state === undefined) {
    return { state: IPP_JOB_STATE.pendingHeld, reasons: ["job-incoming"], message: "Waiting for the document to arrive" };
  }
  switch (state) {
    case "draft":
      return { state: IPP_JOB_STATE.pendingHeld, reasons: [HOLD], message: "Printio is getting this job ready" };
    case "held":
      return { state: IPP_JOB_STATE.pendingHeld, reasons: [HOLD], message: describeHeld(webMessage) };
    case "pending_approval":
      return { state: IPP_JOB_STATE.pendingHeld, reasons: [HOLD], message: "Waiting for approval in Printio" };
    case "approved":
    case "claimed":
      // The printer could not take the job yet (off, offline, cause unknown): still queued, not failed. The web app
      // says which; the phone gets a short plain sentence either way.
      if (waiting === "unavailable") {
        return { state: IPP_JOB_STATE.pending, reasons: ["job-queued"], message: "Waiting for the printer - it is off or offline" };
      }
      if (waiting === "unknown") {
        return { state: IPP_JOB_STATE.pending, reasons: ["job-queued"], message: "Waiting for the printer - status unknown" };
      }
      return { state: IPP_JOB_STATE.pending, reasons: ["job-queued"], message: "Waiting for the printer" };
    case "downloading":
    case "downloaded":
      return { state: IPP_JOB_STATE.pending, reasons: ["job-queued"], message: "Waiting for the printer" };
    case "printing":
    case "submitted_to_spooler":
      return { state: IPP_JOB_STATE.processing, reasons: ["job-printing"], message: "Printing" };
    case "completed":
      return { state: IPP_JOB_STATE.completed, reasons: ["job-completed-successfully"], message: "Sent to the printer. It may take a few moments to start printing." };
    case "cancelled":
      return { state: IPP_JOB_STATE.canceled, reasons: ["job-canceled-by-user"], message: "Cancelled" };
    case "denied":
      return {
        state: IPP_JOB_STATE.aborted,
        reasons: ["aborted-by-system"],
        message: webMessage?.trim() ? trim(webMessage.trim()) : "Your organization's print rules do not allow this job",
      };
    case "rejected":
      return { state: IPP_JOB_STATE.aborted, reasons: ["aborted-by-system"], message: "An approver declined this job in Printio" };
    case "expired":
      return { state: IPP_JOB_STATE.aborted, reasons: ["aborted-by-system"], message: "This job waited too long and was cancelled" };
    case "failed":
      // The web's error text can be technical; the phone gets a plain sentence and the details stay in Printio.
      return { state: IPP_JOB_STATE.aborted, reasons: ["aborted-by-system"], message: `The printer could not print this job. ${ACT} for details` };
    default:
      // A state this gateway does not know about (web newer than gateway): held, never done.
      return { state: IPP_JOB_STATE.pendingHeld, reasons: [HOLD], message: `${ACT} to see this job` };
  }
}
