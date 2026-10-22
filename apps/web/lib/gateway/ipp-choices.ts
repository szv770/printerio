/**
 * IPP job attributes -> the website's plain `PrintChoices`, for jobs that arrive through the IPP gateway
 * (docs/superpowers/specs/2026-10-22-gateway-contract.md, "IPP attributes -> PrintChoices").
 *
 * Pure and total: it never throws, whatever the print dialog sent. Anything it cannot honour is not guessed at;
 * it comes back as `heldReason`, a plain sentence the member can act on, and the caller creates the job as held.
 * Booklet and staple are never produced here (Phase 4); they are chosen on the website.
 *
 * `attributes` is the flattened IPP job-template object exactly as tools/ipp-spike/ipp.mjs `flatten()` makes it:
 * integers/enums are numbers, keywords/names are strings, a single value is unwrapped (several stay an array),
 * a rangeOfInteger is `[lo, hi]`, and a collection (media-col) is a nested object.
 */
import { MAX_COPIES, type PrintChoices } from "@/lib/print-choices";

export type IppAttributes = Record<string, unknown>;

export interface IppChoicesResult {
  choices: PrintChoices;
  /** Plain-language reason the job must be held instead of printed, or null. */
  heldReason: string | null;
}

const LETTER_KEYWORD = "na_letter_8.5x11in";
/** Letter in hundredths of a millimetre (21590 x 27940), with the tolerance the contract allows. */
const LETTER_X = 21590;
const LETTER_Y = 27940;
const LETTER_TOLERANCE = 100;
/** Some clients send "to the end of the document" as an enormous upper bound. */
const OPEN_ENDED_HI = 2147483647;
const MAX_RANGES = 100;
const MAX_JOB_NAME_CHARS = 60;

/** An attribute may be one value or a list of them; the first value is the one that applies. */
function asList(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d{1,10}$/.test(v.trim())) return Number(v.trim());
  return null;
}

function describe(v: unknown): string {
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "unknown";
  return s.replace(/[^\w.\- ]/g, "").slice(0, 40) || "unknown";
}

function mapCopies(raw: unknown, reasons: string[]): number {
  if (raw === undefined) return 1;
  const n = toInt(asList(raw)[0]);
  if (n !== null && n >= 1 && n <= MAX_COPIES) return n;
  reasons.push(`The number of copies must be 1 to ${MAX_COPIES}, so nothing was printed. Choose the copies again on the website.`);
  return 1;
}

function mapSides(raw: unknown, reasons: string[]): "one" | "two" {
  if (raw === undefined) return "one";
  const v = asList(raw)[0];
  if (v === "one-sided") return "one";
  if (v === "two-sided-long-edge") return "two";
  if (v === "two-sided-short-edge") {
    reasons.push("Flip on the short edge is not available from the print dialog yet; choose double-sided or use the website.");
    return "two";
  }
  reasons.push(`Printio does not recognise the sides setting "${describe(v)}", so nothing was printed. Choose single-sided or double-sided on the website.`);
  return "one";
}

/** `[lo, hi]` pairs (one pair, or a list of pairs) -> "1-5, 8". Null = invalid. */
function pairsFrom(raw: unknown): Array<[number, number]> | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return [];
  // One rangeOfInteger arrives as a bare [lo, hi]; several arrive as [[lo, hi], ...].
  const list: unknown[] = raw.every((x) => typeof x === "number") ? (raw.length === 2 ? [raw] : []) : raw;
  if (list.length === 0 && raw.length !== 0) return null;
  const pairs: Array<[number, number]> = [];
  for (const item of list) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const lo = toInt(item[0]);
    const hi = toInt(item[1]);
    if (lo === null || hi === null || lo < 1 || hi < lo) return null;
    pairs.push([lo, hi]);
  }
  return pairs;
}

function mapPageRanges(raw: unknown, reasons: string[]): string {
  if (raw === undefined) return "";
  const pairs = pairsFrom(raw);
  if (pairs === null || pairs.length > MAX_RANGES) {
    reasons.push("The page range from the print dialog could not be read, so nothing was printed. Choose the pages again on the website.");
    return "";
  }
  return pairs
    .map(([lo, hi]) => (hi >= OPEN_ENDED_HI ? `${lo}-` : lo === hi ? String(lo) : `${lo}-${hi}`))
    .join(", ");
}

function isLetterSize(x: unknown, y: unknown): boolean {
  const xi = toInt(x);
  const yi = toInt(y);
  return xi !== null && yi !== null && Math.abs(xi - LETTER_X) <= LETTER_TOLERANCE && Math.abs(yi - LETTER_Y) <= LETTER_TOLERANCE;
}

function mapMedia(attrs: IppAttributes, reasons: string[]): void {
  const notAvailable = (what: string) =>
    reasons.push(`Paper size ${what} is not available yet; only Letter can be printed from the print dialog. Use the website for other sizes.`);

  if (attrs["media"] !== undefined) {
    const v = asList(attrs["media"])[0];
    if (typeof v !== "string" || v.trim().toLowerCase() !== LETTER_KEYWORD) {
      notAvailable(describe(v));
      return;
    }
  }
  if (attrs["media-col"] !== undefined) {
    const col = asList(attrs["media-col"])[0];
    const size = col && typeof col === "object" ? (col as Record<string, unknown>)["media-size"] : undefined;
    const dims = size && typeof size === "object" ? (size as Record<string, unknown>) : null;
    // A media-col without a media-size (only a tray or type) does not change the paper size: ignore it.
    if (dims && (dims["x-dimension"] !== undefined || dims["y-dimension"] !== undefined)) {
      if (!isLetterSize(dims["x-dimension"], dims["y-dimension"])) {
        const x = toInt(dims["x-dimension"]);
        const y = toInt(dims["y-dimension"]);
        notAvailable(x !== null && y !== null ? `${(x / 100).toFixed(0)} x ${(y / 100).toFixed(0)} mm` : "from the print dialog");
      }
    }
  }
}

function mapFinishings(raw: unknown, reasons: string[]): void {
  if (raw === undefined) return;
  const values = asList(raw).map(toInt);
  if (values.every((v) => v === 3)) return; // 3 = none
  reasons.push("Staple and other finishing from the print dialog is not available yet; choose it on the website.");
}

/** "Quarterly report.docx" style job names -> a safe `<name>.pdf`: letters, digits, space and . _ - only, max 60. */
export function ippFileName(jobName: unknown): string {
  const raw = typeof jobName === "string" ? jobName : "";
  const base = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop accents instead of the whole letter
    .replace(/[^A-Za-z0-9 ._-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.pdf$/i, "")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, MAX_JOB_NAME_CHARS)
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return `${base || "Print job"}.pdf`;
}

export function mapIppChoices(attributes: IppAttributes | null | undefined): IppChoicesResult {
  const attrs: IppAttributes = attributes && typeof attributes === "object" && !Array.isArray(attributes) ? attributes : {};
  const reasons: string[] = [];

  const copies = mapCopies(attrs["copies"], reasons);
  const sides = mapSides(attrs["sides"], reasons);
  const pageRange = mapPageRanges(attrs["page-ranges"], reasons);
  mapMedia(attrs, reasons);
  mapFinishings(attrs["finishings"], reasons);
  // orientation-requested, print-quality, print-color-mode, printer-resolution, print-scaling, document-format,
  // job-name and everything else: deliberately ignored here (printer defaults; the PDF carries its orientation).

  return {
    choices: { sides, staple: "none", booklet: "none", copies, pageRange },
    heldReason: reasons.length > 0 ? reasons.join(" ") : null,
  };
}
