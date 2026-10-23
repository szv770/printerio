import type { QuotaBasis } from "@printio/shared";
import { jobSizeText, timeAgo } from "./format";

/** Pure logic behind the teacher home. */

export function firstName(displayName: string | null | undefined, email: string): string {
  const first = displayName?.trim().split(/\s+/)[0];
  return first || email.split("@")[0] || email;
}

const QUOTA_LABEL: Record<QuotaBasis, string> = {
  pdf_pages: "Pages left this month",
  printed_sides: "Sides left this month",
  physical_sheets: "Sheets left this month",
  color_weighted: "Sheets left this month",
};

export interface QuotaCardData {
  label: string;
  remaining: number;
  /** 0-100, how much of the allowance is still unused. */
  percentLeft: number;
}

/** null when the person has no limit, so the card is not shown at all. */
export function quotaCard(input: { limit: number | null; used: number; basis: QuotaBasis }): QuotaCardData | null {
  if (input.limit === null) return null;
  const remaining = Math.max(0, input.limit - input.used);
  const percentLeft = input.limit > 0 ? Math.round((remaining / input.limit) * 100) : 0;
  return { label: QUOTA_LABEL[input.basis], remaining, percentLeft };
}

export interface StatusCard {
  id: "quota" | "printing" | "waiting";
  label: string;
  value: string;
  note?: string;
  percentLeft?: number;
}

export function statusCards(input: { quota: QuotaCardData | null; printing: number; waiting: number }): StatusCard[] {
  const { quota, printing, waiting } = input;
  if (quota) {
    return [
      { id: "quota", label: quota.label, value: quota.remaining.toLocaleString("en-US"), percentLeft: quota.percentLeft },
      { id: "printing", label: "Printing now", value: String(printing), note: waiting > 0 ? `${waiting} waiting for approval` : undefined },
    ];
  }
  return [
    { id: "printing", label: "Printing now", value: String(printing) },
    { id: "waiting", label: "Waiting for approval", value: String(waiting) },
  ];
}

export function jobMetaLine(job: { pages: number; copies: number; createdAt: string }, now: Date): string {
  return [jobSizeText(job.pages, job.copies), timeAgo(job.createdAt, now)].filter(Boolean).join(" · ");
}

export function teacherEmptyText(): string {
  return "No prints yet. Tap Print to send your first one.";
}
