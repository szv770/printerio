/**
 * IPP job attributes -> the website's plain `PrintChoices`, for jobs that arrive through the IPP gateway
 * (docs/superpowers/specs/2026-10-22-gateway-contract.md, "IPP attributes -> PrintChoices").
 *
 * Pure and total: it never throws, whatever the print dialog sent. Anything it cannot honour is not guessed at;
 * it comes back as `heldReason`, a plain sentence the member can act on, and the caller creates the job as held.
 * Staple (top-left / top-right) and booklet come from the `finishings` enum, see mapFinishings. A staple with a
 * short-edge flip or a non-portrait page, several staples, or an unlisted finishing is held, and then carries
 * staple "none" / booklet "none" so a held request never promises finishing it did not check. The one exception
 * is a plain booklet request (8 / 13): it is held only to ask left or right binding and keeps booklet set.
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

function mapSides(raw: unknown, reasons: string[]): { sides: "one" | "two"; flip?: "short" } {
  if (raw === undefined) return { sides: "one" };
  const v = asList(raw)[0];
  if (v === "one-sided") return { sides: "one" };
  if (v === "two-sided-long-edge") return { sides: "two" };
  // Flip on the short edge is delivered with the printer's own BINDING=SHORTEDGE (the setting every booklet already
  // uses). A booklet drops the flip later (it is always short-edge); a corner staple with it is held in mapFinishings.
  if (v === "two-sided-short-edge") return { sides: "two", flip: "short" };
  reasons.push(`Printio does not recognise the sides setting "${describe(v)}", so nothing was printed. Choose single-sided or double-sided on the website.`);
  return { sides: "one" };
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

/**
 * IPP `finishings` enum values (RFC 8011 section 5.2.6 / PWG 5100.1). Values are numbers, NOT the ones the setup
 * design doc once listed (booklet-maker is 13, not 28; 28 is staple-dual-left).
 * Delivered: 3 none, 4 staple (printer's choice of corner -> top-left, the printer's own default), 20 top-left,
 * 22 top-right.
 * Held for one tap: 8 saddle-stitch and 13 booklet-maker. A print dialog can only say "booklet", never left or
 * right binding, and a booklet must not depend on a printer-profile binding edge or on separate Windows queues.
 * So the job is held with "Booklet: choose left or right binding." and still carries booklet (the "profile" value
 * is only a placeholder; the member's choice on the job page replaces it, see finishHeldBookletAction), so the
 * card opens with Booklet already chosen. Everything else is held as unavailable.
 */
/** Shown to the member as the held reason; the job page recognises a held booklet by its finishing, not this text. */
export const BOOKLET_BINDING_REASON = "Booklet: choose left or right binding.";
const FIN_NONE = 3;
const FIN_STAPLE = 4;
const FIN_SADDLE_STITCH = 8;
const FIN_BOOKLET_MAKER = 13;
const FIN_STAPLE_TOP_LEFT = 20;
const FIN_STAPLE_TOP_RIGHT = 22;
/** orientation-requested: 3 portrait, 4 landscape, 5 reverse-landscape, 6 reverse-portrait. */
const NON_PORTRAIT = new Set([4, 5, 6]);

interface Finishing {
  staple: "none" | "top-left" | "top-right";
  booklet: boolean;
}

function mapFinishings(raw: unknown, orientation: unknown, sidesRaw: unknown, reasons: string[]): Finishing {
  const none: Finishing = { staple: "none", booklet: false };
  if (raw === undefined) return none;
  const values = asList(raw).map(toInt);
  const unknown = values.filter((v) => v === null || ![FIN_NONE, FIN_STAPLE, FIN_STAPLE_TOP_LEFT, FIN_STAPLE_TOP_RIGHT, FIN_SADDLE_STITCH, FIN_BOOKLET_MAKER].includes(v));
  if (unknown.length > 0) {
    const first = unknown[0];
    reasons.push(
      `The finishing option (${first === null || first === undefined ? "unknown" : describe(first)}) from the print dialog is not available yet, so nothing was printed. Only staple and booklet can be chosen; choose it on the website.`,
    );
    return none;
  }
  const staples = new Set<"top-left" | "top-right">();
  let booklet = false;
  for (const v of values) {
    if (v === FIN_STAPLE || v === FIN_STAPLE_TOP_LEFT) staples.add("top-left");
    else if (v === FIN_STAPLE_TOP_RIGHT) staples.add("top-right");
    else if (v === FIN_SADDLE_STITCH || v === FIN_BOOKLET_MAKER) booklet = true;
  }
  if (staples.size > 1) {
    reasons.push("The print dialog asked for more than one staple position, so nothing was printed. Choose one corner on the website.");
    return none;
  }
  const staple = staples.size === 1 ? ([...staples][0] as "top-left" | "top-right") : "none";
  if (booklet && staple !== "none") {
    reasons.push("A booklet is stapled for you, so it cannot also be stapled in a corner. Choose either a booklet or a staple.");
    return none;
  }
  if (booklet) reasons.push(BOOKLET_BINDING_REASON);
  if (staple !== "none") {
    if (asList(sidesRaw)[0] === "two-sided-short-edge") {
      reasons.push("A corner staple cannot be combined with a flip on the short edge yet, so nothing was printed. Choose double-sided (long edge) with the staple, or use the website.");
      return none;
    }
    const o = toInt(asList(orientation)[0]);
    if (o !== null && NON_PORTRAIT.has(o)) {
      reasons.push("The staple corner is only checked on portrait pages, so nothing was printed. Choose the staple on the website.");
      return none;
    }
  }
  return { staple, booklet };
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
  const pageRange = mapPageRanges(attrs["page-ranges"], reasons);
  mapMedia(attrs, reasons);
  const fin = mapFinishings(attrs["finishings"], attrs["orientation-requested"], attrs["sides"], reasons);
  const mappedSides = mapSides(attrs["sides"], reasons);
  // orientation-requested, print-quality, print-color-mode, printer-resolution, print-scaling, document-format,
  // job-name and everything else: deliberately ignored here (printer defaults; the PDF carries its orientation).

  return {
    choices: {
      // A booklet is always double-sided whatever flip the dialog asked for (the short-edge flip is part of it).
      sides: fin.booklet ? "two" : mappedSides.sides,
      ...(!fin.booklet && mappedSides.flip ? { flip: mappedSides.flip } : {}),
      staple: fin.staple,
      booklet: fin.booklet ? "profile" : "none",
      copies,
      pageRange,
    },
    heldReason: reasons.length > 0 ? reasons.join(" ") : null,
  };
}
