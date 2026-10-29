/** How a printer's reported status reads to people (lists and a waiting job). The detail is the printer's own message. */

export type StatusTone = "success" | "warning" | "neutral";

export function printerStatusLabel(status: string, detail: string | null | undefined): { label: string; tone: StatusTone } {
  if (status === "online") return { label: "Ready", tone: "success" };
  if (status === "error") return { label: detail?.trim() ? detail.trim() : "Needs attention", tone: "warning" };
  if (status === "offline") return { label: "Offline", tone: "neutral" };
  return { label: "Status unknown", tone: "neutral" };
}

/** One sentence for someone whose job is waiting; null when the printer is fine or unknown, so a normal wait is not blamed on it. */
export function printerSaysLine(status: string, detail: string | null | undefined): string | null {
  if (status === "error") return detail?.trim() ? `The printer says: ${detail.trim().replace(/[.!]+$/, "")}.` : "The printer needs attention.";
  if (status === "offline") return detail?.trim() === "Printio cannot reach the printer" ? "Printio cannot reach the printer right now." : "The printer looks offline right now.";
  return null;
}
