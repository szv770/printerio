import { classifyPrinterStatus, sanitizePrinterDisplay } from "@printio/shared";

/**
 * What a print agent reports about its direct-port printers (the printer's own status answer), narrowed and turned into
 * what is stored. The report is DISPLAY-ONLY: it never decides who may print or what happens to a job, and it is only
 * ever accepted for a printer that belongs to the reporting agent.
 */

export interface ProbeReport {
  printerId: string;
  reachable: boolean;
  answered: boolean;
  online?: boolean;
  code?: number;
  display?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REPORTS = 20;

export function narrowProbeReports(input: unknown, ownPrinterIds: ReadonlySet<string>): ProbeReport[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: ProbeReport[] = [];
  for (const item of input.slice(0, MAX_REPORTS * 2)) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.printerId !== "string" || !UUID.test(r.printerId) || !ownPrinterIds.has(r.printerId) || seen.has(r.printerId)) continue;
    if (typeof r.reachable !== "boolean" || typeof r.answered !== "boolean") continue;
    seen.add(r.printerId);
    const report: ProbeReport = { printerId: r.printerId, reachable: r.reachable, answered: r.answered };
    if (typeof r.online === "boolean") report.online = r.online;
    if (typeof r.code === "number" && Number.isInteger(r.code) && r.code >= 0 && r.code <= 99999) report.code = r.code;
    const display = typeof r.display === "string" ? sanitizePrinterDisplay(r.display) : undefined;
    if (display !== undefined) report.display = display;
    out.push(report);
    if (out.length >= MAX_REPORTS) break;
  }
  return out;
}

export interface PrinterStatusUpdate {
  status?: "online" | "offline" | "error";
  status_detail?: string | null;
  status_code?: number | null;
  last_status_at: string;
}

/** The columns to write for one report. A printer that connects but stays silent proves nothing, so only the check time is noted. */
export function printerUpdateFromReport(r: ProbeReport, nowIso: string): PrinterStatusUpdate {
  const { level } = classifyPrinterStatus(r);
  if (level === "unknown") return { last_status_at: nowIso };
  if (!r.reachable) return { status: "offline", status_detail: "Printio cannot reach the printer", status_code: null, last_status_at: nowIso };
  const status = level === "offline" ? "offline" : level === "attention" || level === "error" ? "error" : "online";
  return { status, status_detail: r.display ?? null, status_code: r.code ?? null, last_status_at: nowIso };
}

export interface RawPrinterTarget {
  printerId: string;
  host: string;
  port: number;
}

/** The direct-port printers an agent should ask about, one entry per printer. */
export function rawPrinterTargets(rows: ReadonlyArray<{ printer_id: string; output_mode: string; raw_host: string | null; raw_port: number }>): RawPrinterTarget[] {
  const seen = new Set<string>();
  const out: RawPrinterTarget[] = [];
  for (const r of rows) {
    if (r.output_mode !== "raw" || !r.raw_host || seen.has(r.printer_id)) continue;
    seen.add(r.printer_id);
    out.push({ printerId: r.printer_id, host: r.raw_host, port: r.raw_port });
  }
  return out;
}
