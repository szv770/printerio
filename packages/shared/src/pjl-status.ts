// Reading and classifying what a Kyocera (HP-compatible PJL) printer says about itself on the raw port.
// The sample answer is from a real TASKalfa MZ8500i, 2026-10-28:
//   @PJL INFO STATUS
//   CODE=10023
//   DISPLAY="Processing..."
//   ONLINE=TRUE
// PJL status codes come in ranges: 10xxx informational (ready, processing), 2xxxx job/parser messages,
// 3xxxx warnings the printer can keep going through, 4xxxx needs someone at the printer (paper out, jam, door open),
// 5xxxx hardware error.

export interface ParsedPjlStatus {
  code?: number;
  display?: string;
  online?: boolean;
}

const MAX_DISPLAY = 120;

/** The printer's own words are shown to people: strip control characters and extra spaces, and keep them short. */
export function sanitizePrinterDisplay(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DISPLAY).trim();
  return cleaned === "" ? undefined : cleaned;
}

/** Reads the answer to `@PJL INFO STATUS`. Null when there is nothing it understands. */
export function parsePjlInfoStatus(text: string): ParsedPjlStatus | null {
  const code = /CODE\s*=\s*(\d{4,6})/i.exec(text);
  const display = /DISPLAY\s*=\s*"([^"]*)"/i.exec(text);
  const online = /ONLINE\s*=\s*(TRUE|FALSE)/i.exec(text);
  if (!code && !display && !online) return null;
  const out: ParsedPjlStatus = {};
  if (code) out.code = Number(code[1]);
  const shown = display ? sanitizePrinterDisplay(display[1]) : undefined;
  if (shown !== undefined) out.display = shown;
  if (online) out.online = online[1]!.toUpperCase() === "TRUE";
  return out;
}

export interface PrinterProbeFacts {
  /** A connection to the printer's port could be made. */
  reachable: boolean;
  /** The printer answered the status question. */
  answered: boolean;
  online?: boolean;
  code?: number;
  display?: string;
}

export type PrinterLevel = "ok" | "warning" | "attention" | "error" | "offline" | "unknown";

/** What the printer's report means for people waiting on it. A silent printer is "unknown", never called a problem we cannot prove. */
export function classifyPrinterStatus(p: PrinterProbeFacts): { level: PrinterLevel; needsAttention: boolean } {
  if (!p.reachable) return { level: "offline", needsAttention: true };
  if (!p.answered) return { level: "unknown", needsAttention: false };
  if (p.online === false) return { level: "offline", needsAttention: true };
  const c = p.code;
  if (c === undefined) return { level: "unknown", needsAttention: false };
  if (c >= 10000 && c < 20000) return { level: "ok", needsAttention: false };
  if (c >= 20000 && c < 40000) return { level: "warning", needsAttention: false };
  if (c >= 40000 && c < 50000) return { level: "attention", needsAttention: true };
  if (c >= 50000 && c < 60000) return { level: "error", needsAttention: true };
  return { level: "unknown", needsAttention: false };
}
