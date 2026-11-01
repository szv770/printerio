/**
 * Printer feedback over the raw port: parsing the PJL USTATUS messages the Kyocera TASKalfa MZ8500i sends back on the
 * SAME connection as the job, after `@PJL USTATUS DEVICE=VERBOSE` / `JOB=ON` / `PAGE=ON` (docs/kyocera-raw-print.md,
 * "What the printer sends back on port 9100 (measured 2026-11-01)"). Formats, all ending in a form feed:
 *   @PJL USTATUS JOB\r\nSTART\r\nNAME="<job name>"\r\n\f
 *   @PJL USTATUS PAGE\r\n<n>\n\r\n\f            one per finished PAGE = printed SIDE (n = 1, 2, 3 ...), several can share a TCP chunk
 *   @PJL USTATUS DEVICE\r\nCODE=<n>\r\nDISPLAY="<text>"\r\nONLINE=TRUE\r\n\f   (10001 Ready., 10023 Processing...)
 *   @PJL USTATUS JOB\r\nEND\r\nNAME="<job name>"\r\nPAGES=<n>\r\n\f   only while the connection is still open as the job ends
 *   (measured: it can arrive on the NEXT connection instead).
 * (PAGE counts printed sides, not sheets: a 4-page duplex x 2 copies job is PAGE 1..8.) Error codes (jam, paper out) have not been seen yet, so classification is cautious:
 * any DEVICE code outside 10xxx means "the printer needs attention" and is shown, never used to fail or re-send.
 *
 * Pure (no clock, no I/O) so the Agent, the web app and the tests share one definition.
 */

export type UstatusReport =
  | { kind: "job_start"; name?: string }
  | { kind: "page"; pages: number }
  | { kind: "job_end"; name?: string; pages?: number }
  | { kind: "device"; code?: number; display?: string };

export interface ParsedUstatus {
  reports: UstatusReport[];
  /** Unfinished tail (a frame still arriving, or the start of a header). Prepend it to the next chunk. */
  rest: string;
}

const MAX_INPUT = 256 * 1024;
const MAX_REST = 64 * 1024;
const MAX_REPORTS = 200;
const MAX_DISPLAY = 120;
const MAX_NAME = 60;
const HEADER = "@PJL USTATUS";

/** Printer-supplied text is untrusted: letters, digits and a little punctuation only, spaces collapsed, capped. */
export function sanitizePrinterText(input: string, max = MAX_DISPLAY): string {
  return input
    .replace(/[^A-Za-z0-9 .,:;'()/_+#%-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function unquote(v: string): string {
  const t = v.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t.replace(/^"/, "");
}

function parseFrame(body: string): UstatusReport | null {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const type = (lines[0] ?? "").split(/\s+/)[0]?.toUpperCase();
  const fields = new Map<string, string>();
  const bare: string[] = [];
  for (const line of lines.slice(1)) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq).trim().toUpperCase(), unquote(line.slice(eq + 1)));
    else if (line) bare.push(line);
  }
  if (type === "JOB") {
    const isStart = bare.some((b) => b.toUpperCase() === "START");
    const isEnd = bare.some((b) => b.toUpperCase() === "END");
    if (!isStart && !isEnd) return null;
    const nameRaw = fields.get("NAME");
    const name = nameRaw === undefined ? undefined : sanitizePrinterText(nameRaw, MAX_NAME);
    if (isStart) return { kind: "job_start", ...(name ? { name } : {}) };
    const p = Number.parseInt(fields.get("PAGES") ?? "", 10);
    return { kind: "job_end", ...(name ? { name } : {}), ...(Number.isFinite(p) && p >= 0 ? { pages: p } : {}) };
  }
  if (type === "PAGE") {
    const n = bare.find((b) => /^\d{1,6}$/.test(b));
    return n === undefined ? null : { kind: "page", pages: Number.parseInt(n, 10) };
  }
  if (type === "DEVICE") {
    const codeRaw = fields.get("CODE");
    const code = codeRaw !== undefined && /^\d{1,6}$/.test(codeRaw.trim()) ? Number.parseInt(codeRaw, 10) : undefined;
    const display = fields.has("DISPLAY") ? sanitizePrinterText(fields.get("DISPLAY") ?? "") : "";
    if (code === undefined && !display) return null;
    return { kind: "device", ...(code !== undefined ? { code } : {}), ...(display ? { display } : {}) };
  }
  return null;
}

/** How much of `s`'s end could be the beginning of a header that has not fully arrived yet. */
function partialHeaderTail(s: string): number {
  const up = s.toUpperCase();
  for (let n = Math.min(HEADER.length - 1, s.length); n > 0; n--) {
    if (HEADER.startsWith(up.slice(up.length - n))) return n;
  }
  return 0;
}

/**
 * Splits `text` into frames (a header up to the next form feed or the next header) and decodes the ones it knows.
 * Only COMPLETE frames are returned; the unfinished tail comes back in `rest` for the next chunk. Never throws,
 * bounded work and bounded output.
 */
export function parseUstatus(text: string): ParsedUstatus {
  const s = typeof text === "string" && text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : typeof text === "string" ? text : "";
  const starts: number[] = [];
  const re = /@PJL[ \t]+USTATUS/gi;
  for (let m = re.exec(s); m; m = re.exec(s)) starts.push(m.index);

  const reports: UstatusReport[] = [];
  let consumed = 0;
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i] as number;
    const ff = s.indexOf("\f", from);
    const next = i + 1 < starts.length ? (starts[i + 1] as number) : -1;
    let endAt: number;
    if (ff >= 0 && (next < 0 || ff < next)) endAt = ff;
    else if (next >= 0) endAt = next;
    else break; // the last frame is still arriving
    consumed = ff >= 0 && endAt === ff ? ff + 1 : endAt;
    const r = parseFrame(s.slice(from + HEADER.length, endAt).replace(/^[ \t]+/, ""));
    if (r && reports.length < MAX_REPORTS) reports.push(r);
  }

  let rest = "";
  const open = starts.find((st) => st >= consumed);
  if (open !== undefined) rest = s.slice(open);
  else {
    const n = partialHeaderTail(s.slice(consumed));
    rest = n > 0 ? s.slice(s.length - n) : "";
  }
  if (rest.length > MAX_REST) rest = rest.slice(rest.length - MAX_REST);
  return { reports, rest };
}

/** 35078 "Sleeping...": measured as a normal idle state (docs/kyocera-raw-print.md); the printer can doze right after a job, so it must never read as a fault. */
const NORMAL_CODES: ReadonlySet<number> = new Set([35078]);

/** 10xxx = the printer's normal states (10001 Ready., 10023 Processing...), plus the known idle state 35078. Anything else with a code needs a look. */
export function isAttentionCode(code: number | undefined): boolean {
  return code !== undefined && !(code >= 10000 && code < 11000) && !NORMAL_CODES.has(code);
}

export interface PrinterAttention {
  code?: number;
  text: string;
}

/**
 * Follows one raw connection's messages. `pages` is the highest finished-page number seen, `attention` is set while
 * the LATEST device message is outside 10xxx (a later 10xxx clears it, e.g. after a jam is cleared).
 */
export class UstatusFeedback {
  pages = 0;
  started = false;
  /** The printer sent JOB END (the strongest confirmation). */
  ended = false;
  attention: PrinterAttention | null = null;
  private rest = "";

  constructor(readonly expectedPages: number) {}

  get complete(): boolean {
    return this.ended || (this.expectedPages > 0 && this.pages >= this.expectedPages);
  }

  /** Feed received bytes (as latin1 text). Returns the reports they completed. */
  push(chunk: string): UstatusReport[] {
    const parsed = parseUstatus(this.rest + chunk);
    this.rest = parsed.rest;
    for (const r of parsed.reports) {
      if (r.kind === "job_start") this.started = true;
      else if (r.kind === "job_end") {
        this.ended = true;
        if (r.pages !== undefined) this.pages = Math.max(this.pages, r.pages);
      } else if (r.kind === "page") this.pages = Math.max(this.pages, r.pages);
      else if (isAttentionCode(r.code)) this.attention = { ...(r.code !== undefined ? { code: r.code } : {}), text: r.display || `printer code ${r.code}` };
      else if (r.code !== undefined) this.attention = null;
    }
    return parsed.reports;
  }
}

/**
 * PAGE messages the printer should send for a job: they count printed SIDES (measured 2026-11-01: 4 pages duplex x 2
 * copies = PAGE 1..8). Plain job: copies x pages sent, duplex or not. Booklet: the PDF sent is the imposed one with two
 * logical pages per side, so ceil((pages + padding) / 2) x copies. (For an odd duplex page count the printer may or may
 * not count the blank back: the listener treats count >= expected as done and never requires it.)
 */
export function expectedRawPages(input: { sourcePages: number; bookletPaddingAdded: number; copies: number; booklet: boolean }): number {
  const sent = input.booklet ? Math.ceil((input.sourcePages + input.bookletPaddingAdded) / 2) : input.sourcePages;
  return sent * input.copies;
}

const MARKER_PREFIX = "[printio:printer-error";
const FALLBACK_TEXT = "The printer needs attention.";

export interface PrinterErrorInfo {
  code?: number;
  text: string;
}

/**
 * Where the printer's attention message lives (no migration): `print_jobs.error_message` of a `failed` job reads
 * `[printio:printer-error v1 code=<code>] <the printer's own words, sanitised>`. The web app never re-queues such a job.
 */
export function formatPrinterErrorMarker(input: { code?: number; text: string }): string {
  const text = sanitizePrinterText(input.text) || FALLBACK_TEXT;
  const code = input.code !== undefined && Number.isFinite(input.code) ? ` code=${Math.trunc(input.code)}` : "";
  return `${MARKER_PREFIX} v1${code}] ${text}`;
}

/** What a person is told after the printer's own words. Honest: the job may still print once the printer is fixed. */
export const PRINTER_ERROR_ADVICE = "Check the printer. The job may still print once it is fixed, so look at the output before sending it again.";

export function printerErrorDetail(info: PrinterErrorInfo): string {
  return `${info.text.replace(/[.!?\s]+$/, "")}. ${PRINTER_ERROR_ADVICE}`;
}

/** Tolerant: null for anything that is not a printer-error marker. */
export function parsePrinterErrorMarker(message: string | null | undefined): PrinterErrorInfo | null {
  if (typeof message !== "string") return null;
  const m = /^\[printio:printer-error\b([^\]]*)\]([\s\S]*)$/.exec(message.trim());
  if (!m) return null;
  const codeMatch = /\bcode=(\d{1,6})\b/.exec(m[1] ?? "");
  const text = sanitizePrinterText(m[2] ?? "") || FALLBACK_TEXT;
  return { ...(codeMatch ? { code: Number.parseInt(codeMatch[1] as string, 10) } : {}), text };
}
