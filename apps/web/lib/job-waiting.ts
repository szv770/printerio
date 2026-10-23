import { parseWaitingMarker, type WaitingInfo } from "@printio/shared";

/**
 * "Waiting for the printer" is a QUEUED job (approved, or briefly claimed while it is being retried) whose
 * error_message carries the marker the release route writes (packages/shared/src/waiting.ts). It is deliberately
 * not a status of its own: the database has no such state, and the job must stay `approved` so the quota
 * reservation, the cancel button and the claim queue keep working untouched.
 *
 * Pure and tolerant: anything that is not exactly that combination is simply not waiting.
 */
export function jobWaiting(status: string, errorMessage: string | null | undefined): WaitingInfo | null {
  if (status !== "approved" && status !== "claimed") return null;
  return parseWaitingMarker(errorMessage);
}

/** The one plain sentence for a list row / phone, or null when the job is not waiting. */
export function jobWaitingLine(input: { status: string; errorMessage?: string | null }): string | null {
  return jobWaiting(input.status, input.errorMessage)?.text ?? null;
}
