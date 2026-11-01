// Builds the PJL header + framing for sending a PDF straight to a Kyocera
// printer's raw port (TCP 9100). Mappings come from real-printer tests on a
// TASKalfa MZ8500i - see docs/kyocera-raw-print.md. Anything not proven
// returns { ok: false } so the caller can HOLD the job instead of guessing.

/** "dual-left" = two staples on the left edge (not a corner). */
export type StaplePosition = "top-left" | "top-right" | "bottom-left" | "dual-left";

/**
 * EVERY dual-staple / 3-hole-punch combination the printer may be sent. Edit this table (flip `proven`) after a
 * labelled real-printer print; nothing else needs to change. A combination that is not listed, or listed with
 * `proven: false`, is HELD with a plain reason. Portrait pages, long-edge duplex only (booklet, short-edge flip and
 * landscape are never listed). "none" staple = no staple at all; "top-left" = the corner staple (STAPLEOPTION=ONE).
 */
export interface FinishingCombo {
  duplex: boolean;
  staple: "none" | "top-left" | "dual-left";
  punch: boolean;
  proven: boolean;
  /** One line: which labelled print proved it, or why it is pending. */
  proof: string;
}
export const PROVEN_FINISHING_COMBOS: FinishingCombo[] = [
  { duplex: false, staple: "dual-left", punch: false, proven: true, proof: "2026-11-01 labelled print: 2 sheets single-sided gave two staples on the left (OUTBIN=OPTIONFACEDOWN STAPLEOPTION=TWO FINISH=STAPLE)." },
  { duplex: false, staple: "none", punch: true, proven: true, proof: "2026-11-01 labelled print: 3 holes on the left edge of every sheet (OUTBIN=OPTIONFACEDOWN FINISH=KPUNCH)." },
  { duplex: true, staple: "none", punch: true, proven: false, proof: "Pending: DUPLEX=ON BINDING=LONGEDGE FINISH=KPUNCH not printed yet." },
  { duplex: false, staple: "top-left", punch: true, proven: false, proof: "Pending: FINISH=KPNCHANDSTPL STAPLEOPTION=ONE not printed yet." },
  { duplex: true, staple: "dual-left", punch: false, proven: false, proof: "Pending: dual staple on a double-sided long-edge job not printed yet." },
];


export interface RawPrintOptions {
  copies: number;
  colorMode: "bw" | "color";
  duplex: boolean;
  jobName: string;
  /** Double-sided only: which edge the sheet flips on. Default "long" (the usual). "short" = BINDING=SHORTEDGE (flip like a notepad); not combinable with a corner staple. Ignored for booklets and single-sided. */
  duplexEdge?: "long" | "short";
  staple?: StaplePosition;
  /** 3-hole punch on the left edge (FINISH=KPUNCH). Only the combinations in PROVEN_FINISHING_COMBOS are sent. */
  punch?: boolean;
  booklet?: boolean;
  /** Only used with booklet; must match how the PDF was imposed. */
  bindingSide?: "left" | "right";
  /** "ledger" = 11x17 sheets (an 11x17 booklet). Without it the printer uses its default paper (letter) and shrinks the pages. Proven by a real booklet print 2026-10-26: PAPER=LEDGER with the booklet settings. */
  paper?: "ledger";
  /** Printer feedback: state the printer's default reporting (@PJL USTATUS JOB=ON / DEVICE=ON; see pjl-ustatus.ts). Off by default: the bytes are then identical to before. */
  ustatus?: boolean;
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

/**
 * A job name that is unique per job: the sanitised title plus a short token (letters and digits only), 60 characters at
 * most. The token survives truncation of a long title, so the printer's JOB END message can be matched to exactly one job.
 */
export function uniquePjlJobName(title: string, token: string): string {
  const t = token.replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  const base = sanitizePjlText(title);
  if (!t) return base;
  return `${base.slice(0, MAX_TEXT - 1 - t.length).trim()} ${t}`;
}

function findFinishingCombo(o: RawPrintOptions): { ok: true } | { ok: false; reason: string } {
  const staple = o.staple ?? "none";
  if (o.punch && staple === "dual-left") return { ok: false, reason: "hole punch together with two staples is not supported" };
  if (o.duplex && o.duplexEdge === "short") return { ok: false, reason: "hole punch or two staples together with a short-edge flip is not supported" };
  if (staple !== "none" && staple !== "dual-left" && staple !== "top-left") return { ok: false, reason: "this finishing combination is not supported" };
  const hit = PROVEN_FINISHING_COMBOS.find((c) => c.duplex === o.duplex && c.punch === !!o.punch && c.staple === staple);
  if (!hit) return { ok: false, reason: "this finishing combination is not supported" };
  if (!hit.proven) return { ok: false, reason: "this finishing combination is not tested on this printer yet" };
  return { ok: true };
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
    if (o.punch) {
      return { ok: false, reason: "booklet together with hole punch is not supported" };
    }
    // Proven 2026-10-19 (E1 left, F1 right): the PDF is imposed for the binding side
    // (mirrored for right) in normal sheet order; the printer setting is the same for both.
    // KREVERSEFOLD scrambles pages - do not use.
    settings.push("DUPLEX=ON", "BINDING=SHORTEDGE", "OUTBIN=KBOOKLET", "FINISH=KFOLD");
  } else {
    const dual = o.staple === "dual-left";
    if (dual || o.punch) {
      const combo = findFinishingCombo(o);
      if (!combo.ok) return combo;
    }
    if (o.duplex && o.duplexEdge === "short" && o.staple) {
      return { ok: false, reason: "a short-edge flip together with a corner staple is not supported" };
    }
    if (o.duplex) settings.push("DUPLEX=ON", o.duplexEdge === "short" ? "BINDING=SHORTEDGE" : "BINDING=LONGEDGE");
    else settings.push("DUPLEX=OFF");
    if (o.punch) {
      // Proven 2026-11-01: single-sided KPUNCH = 3 holes on the left edge. With a corner staple: KPNCHANDSTPL (pending).
      settings.push("OUTBIN=OPTIONFACEDOWN");
      if (o.staple === "top-left") settings.push("STAPLEOPTION=ONE", "FINISH=KPNCHANDSTPL");
      else settings.push("FINISH=KPUNCH");
    } else if (dual) {
      // Proven 2026-11-01: single-sided, two staples on the left edge.
      settings.push("OUTBIN=OPTIONFACEDOWN", "STAPLEOPTION=TWO", "FINISH=STAPLE");
    } else if (o.staple) {
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
  // Only the printer's own defaults (JOB and DEVICE messages on): PAGE/TIMED/VERBOSE are never set, the Kyocera remembers them.
  const ustatus = o.ustatus ? "@PJL USTATUS JOB=ON\r\n@PJL USTATUS DEVICE=ON\r\n" : "";
  let head = `${UEL}@PJL\r\n${ustatus}@PJL JOB NAME="${name}"\r\n`;
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
