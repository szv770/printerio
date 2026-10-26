// Builds the PJL header + framing for sending a PDF straight to a Kyocera
// printer's raw port (TCP 9100). Mappings come from real-printer tests on a
// TASKalfa MZ8500i - see docs/kyocera-raw-print.md. Anything not proven
// returns { ok: false } so the caller can HOLD the job instead of guessing.

export type StaplePosition = "top-left" | "top-right" | "bottom-left";

export interface RawPrintOptions {
  copies: number;
  colorMode: "bw" | "color";
  duplex: boolean;
  jobName: string;
  /** Double-sided only: which edge the sheet flips on. Default "long" (the usual). "short" = BINDING=SHORTEDGE (flip like a notepad); not combinable with a corner staple. Ignored for booklets and single-sided. */
  duplexEdge?: "long" | "short";
  staple?: StaplePosition;
  booklet?: boolean;
  /** Only used with booklet; must match how the PDF was imposed. */
  bindingSide?: "left" | "right";
  /** "ledger" = 11x17 sheets (an 11x17 booklet). Without it the printer uses its default paper (letter) and shrinks the pages. Proven by a real booklet print 2026-10-26: PAPER=LEDGER with the booklet settings. */
  paper?: "ledger";
}

import { containsPjlEscape, PJL_ESCAPE_MESSAGE } from "./pjl-escape";

export type PjlSettingsResult = { ok: true; settings: string[] } | { ok: false; reason: string };
export type RawJobResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

const UEL = "\x1b%-12345X";
const MAX_TEXT = 60;

/** Job names/users are member-controlled; keep them from injecting PJL or escape sequences. */
export function sanitizePjlText(input: string): string {
  const s = input.replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, MAX_TEXT).trim();
  return s || "printio";
}

export function buildPjlSettings(o: RawPrintOptions): PjlSettingsResult {
  if (!Number.isInteger(o.copies) || o.copies < 1 || o.copies > 999) {
    return { ok: false, reason: `invalid copies: ${o.copies}` };
  }
  const settings: string[] = [];

  if (o.booklet) {
    if (o.bindingSide !== "left" && o.bindingSide !== "right") {
      return { ok: false, reason: "booklet needs a binding side" };
    }
    if (o.staple) {
      return { ok: false, reason: "booklet together with a separate staple is not supported" };
    }
    // Proven 2026-10-19 (E1 left, F1 right): the PDF is imposed for the binding side
    // (mirrored for right) in normal sheet order; the printer setting is the same for both.
    // KREVERSEFOLD scrambles pages - do not use.
    settings.push("DUPLEX=ON", "BINDING=SHORTEDGE", "OUTBIN=KBOOKLET", "FINISH=KFOLD");
  } else {
    if (o.duplex && o.duplexEdge === "short" && o.staple) {
      return { ok: false, reason: "a short-edge flip together with a corner staple is not supported" };
    }
    if (o.duplex) settings.push("DUPLEX=ON", o.duplexEdge === "short" ? "BINDING=SHORTEDGE" : "BINDING=LONGEDGE");
    else settings.push("DUPLEX=OFF");
    if (o.staple) {
      // Position map from labelled real-printer tests (portrait page, duplex long edge):
      //   ONE                         -> top-left      (S2, S3)
      //   ONE + KFEEDEDGE=SHORTEDGE   -> top-right     (P1)
      //   ONEOPPOSED                  -> bottom-left   (S1, S4, S5)
      settings.push("OUTBIN=OPTIONFACEDOWN");
      if (o.staple === "top-right") settings.push("KFEEDEDGE=SHORTEDGE");
      settings.push(o.staple === "bottom-left" ? "STAPLEOPTION=ONEOPPOSED" : "STAPLEOPTION=ONE", "FINISH=STAPLE");
    }
  }

  if (o.paper === "ledger") settings.push("PAPER=LEDGER");
  settings.push(`QTY=${o.copies}`);
  // KCOLORMODE=MONO is deliberately NOT sent: unverified on the printer, and the web form stores colour as
  // "bw" by default, which would turn staff prints grey. Add it back only after a labelled test proves it.
  return { ok: true, settings };
}

export function buildRawJob(o: RawPrintOptions, pdf: Uint8Array): RawJobResult {
  const s = buildPjlSettings(o);
  if (!s.ok) return s;
  // Defence in depth (security review F1): a document carrying a UEL would let its own bytes run PJL on the
  // printer. Callers already refuse such files earlier; this makes it impossible to build the job at all.
  if (containsPjlEscape(pdf)) throw new Error(PJL_ESCAPE_MESSAGE);
  const name = sanitizePjlText(o.jobName);
  let head = `${UEL}@PJL\r\n@PJL JOB NAME="${name}"\r\n`;
  for (const line of s.settings) head += `@PJL SET ${line}\r\n`;
  head += "@PJL ENTER LANGUAGE=PDF\r\n";
  const tail = `\r\n${UEL}@PJL EOJ NAME="${name}"\r\n${UEL}`;
  const enc = (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0) & 0xff);
  const h = enc(head);
  const t = enc(tail);
  const bytes = new Uint8Array(h.length + pdf.length + t.length);
  bytes.set(h, 0);
  bytes.set(pdf, h.length);
  bytes.set(t, h.length + pdf.length);
  return { ok: true, bytes };
}
