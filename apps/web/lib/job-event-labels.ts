import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Ban,
  CheckCircle,
  CheckCircle2,
  Clock,
  Download,
  FilePlus2,
  Printer,
  RotateCw,
  ScanLine,
  ShieldCheck,
  Slash,
  Upload,
} from "lucide-react";

/**
 * Plain-English rendering of print_job_events.event_type, the same way
 * job-status-labels.ts does it for print_jobs.status.
 *
 * The job detail page used to print these constants raw - a student chasing
 * their assignment saw "PREFLIGHT_COMPLETED", "POLICY_EVALUATED",
 * "SPOOLER_ACCEPTED". Those are internal pipeline names; they say nothing to
 * the person whose document it is. The history is the one place a user goes
 * to answer "where did my job get to", so it has to read as a sentence, not
 * as a log line.
 *
 * Keys mirror supabase/migrations/0003_jobs_tables.sql's CHECK constraint
 * exactly - job-event-labels.test.ts parses that migration and fails if the
 * two ever drift apart.
 */
export const JOB_EVENT_TYPES = [
  "JOB_CREATED",
  "PDF_UPLOADED",
  "PREFLIGHT_COMPLETED",
  "PREFLIGHT_REJECTED",
  "POLICY_EVALUATED",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "REJECTED",
  "DENIED",
  "JOB_EXPIRED",
  "JOB_CANCELLED",
  "AGENT_CLAIMED",
  "LEASE_EXPIRED",
  "DOWNLOAD_STARTED",
  "DOWNLOAD_COMPLETED",
  "PRINT_SUBMITTED",
  "SPOOLER_ACCEPTED",
  "PRINT_FAILED",
  "JOB_COMPLETED",
  "RETRY_SCHEDULED",
] as const;

export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

export interface JobEventDisplay {
  Icon: LucideIcon;
  label: string;
}

export const JOB_EVENT_DISPLAY: Record<JobEventType, JobEventDisplay> = {
  JOB_CREATED: { Icon: FilePlus2, label: "Job created" },
  PDF_UPLOADED: { Icon: Upload, label: "Document uploaded" },
  PREFLIGHT_COMPLETED: { Icon: ScanLine, label: "Document checked" },
  PREFLIGHT_REJECTED: { Icon: AlertTriangle, label: "Document could not be read" },
  POLICY_EVALUATED: { Icon: ShieldCheck, label: "Print rules checked" },
  APPROVAL_REQUIRED: { Icon: Clock, label: "Sent for approval" },
  APPROVED: { Icon: CheckCircle2, label: "Approved" },
  REJECTED: { Icon: Ban, label: "Rejected by an approver" },
  DENIED: { Icon: Ban, label: "Denied by print rules" },
  JOB_EXPIRED: { Icon: Slash, label: "Expired before it was approved" },
  JOB_CANCELLED: { Icon: Slash, label: "Cancelled" },
  AGENT_CLAIMED: { Icon: Printer, label: "Picked up by the printer" },
  LEASE_EXPIRED: { Icon: RotateCw, label: "Printer timed out - returned to the queue" },
  DOWNLOAD_STARTED: { Icon: Download, label: "Sending to the printer" },
  DOWNLOAD_COMPLETED: { Icon: Download, label: "Received by the printer" },
  PRINT_SUBMITTED: { Icon: Printer, label: "Sent to the print queue" },
  SPOOLER_ACCEPTED: { Icon: Printer, label: "Accepted by the print queue" },
  PRINT_FAILED: { Icon: AlertTriangle, label: "Printing failed" },
  JOB_COMPLETED: { Icon: CheckCircle, label: "Finished printing" },
  RETRY_SCHEDULED: { Icon: RotateCw, label: "Retrying" },
};

/** Falls back to the raw constant for an event type added to the DB but not
 *  yet given a label here - a history line the user can't read is still
 *  better than a history line that isn't there. */
export function jobEventDisplay(eventType: string): JobEventDisplay {
  return (JOB_EVENT_DISPLAY as Record<string, JobEventDisplay>)[eventType] ?? { Icon: FilePlus2, label: eventType };
}
