import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { resolvePaperSizePoints } from "./imposition";

/**
 * The one-page PDF behind Admin → "Send test print" (see
 * app/admin/printers/actions.ts's sendTestPrintAction).
 *
 * Generated rather than bundled so the sheet that comes out of the machine
 * *identifies itself*: which queue it was aimed at, which Windows queue name
 * that resolves to, who sent it and when, and the job id to look it up under
 * in Printio. An admin standing at a shared MFP with three queues mapped to
 * it can then tell which of them actually produced the page in their hand -
 * a generic "TEST PAGE" sheet could not answer that.
 *
 * It is a completely ordinary PDF: the caller runs it through the same
 * `preflightPdf` every upload goes through, stores it in the same private
 * bucket, and the Agent downloads and prints it exactly as it would a
 * student's essay. Nothing about this file takes a shortcut through the
 * pipeline.
 */

export interface TestPrintPdfInput {
  /** printer_profiles.label - the profile this test is aimed at. */
  profileLabel: string;
  /** printer_profiles.windows_queue_name - what the Agent will submit to. */
  windowsQueueName: string;
  /** printers.name - the physical device the profile hangs off. */
  printerName: string;
  /** Display name or email of the org_admin who pressed the button. */
  sentBy: string;
  /** The organization the profile belongs to. */
  organizationName: string;
  /** print_jobs.id, so the sheet can be matched back to its job page. */
  jobId: string;
  sentAt: Date;
  /** Paper size the job requests (a profile's first declared size). */
  paperSize: string;
}

/**
 * pdf-lib's standard (non-embedded) fonts encode WinAnsi only, and
 * `drawText` throws outright on a character outside it - so a Hebrew display
 * name or an emoji in a profile label would otherwise fail the whole test
 * print rather than printing a page with an odd character on it. Anything
 * unencodable becomes "?" here instead. (Embedding a full Unicode font just
 * to render a queue name would add megabytes to every test print for no
 * printing benefit.)
 */
export function toWinAnsiSafe(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // Printable ASCII, plus Latin-1's printable upper range. The 0x80-0x9F
    // block is deliberately excluded: it is CP1252-specific and not worth
    // the per-glyph uncertainty on a diagnostic page.
    out += (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? char : "?";
  }
  return out;
}

/** Truncates with an ellipsis so a very long label can never run off the sheet. */
function fitToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && font.widthOfTextAtSize(`${truncated}...`, size) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}...`;
}

/** Same formatting everywhere (UTC, unambiguous) - the sheet is read next to
 *  a screen showing the job page, so "2026-09-07 14:03 UTC" beats a locale
 *  string that depends on which machine rendered it. */
export function formatTestPrintTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

const MARGIN_PT = 54; // 0.75in - inside every printer's unprintable edge

export async function createTestPrintPdf(input: TestPrintPdfInput): Promise<Uint8Array> {
  const sheet = resolvePaperSizePoints(input.paperSize);
  const doc = await PDFDocument.create();
  doc.setTitle(`Printio test print - ${toWinAnsiSafe(input.profileLabel)}`);
  doc.setProducer("Printio");
  doc.setCreator("Printio");

  const page = doc.addPage([sheet.width, sheet.height]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const ink = rgb(0.05, 0.05, 0.05);
  const muted = rgb(0.42, 0.42, 0.42);
  const contentWidth = sheet.width - MARGIN_PT * 2;

  // A border and corner ticks make the page useful as a *print* test and not
  // just as text: they show at a glance whether the queue's driver defaults
  // are scaling the page down, shifting it, or clipping an edge.
  page.drawRectangle({
    x: MARGIN_PT,
    y: MARGIN_PT,
    width: contentWidth,
    height: sheet.height - MARGIN_PT * 2,
    borderColor: muted,
    borderWidth: 0.75,
  });
  const tick = 18;
  for (const [x, y, dx, dy] of [
    [MARGIN_PT, MARGIN_PT, 1, 1],
    [sheet.width - MARGIN_PT, MARGIN_PT, -1, 1],
    [MARGIN_PT, sheet.height - MARGIN_PT, 1, -1],
    [sheet.width - MARGIN_PT, sheet.height - MARGIN_PT, -1, -1],
  ] as const) {
    page.drawLine({ start: { x, y }, end: { x: x + dx * tick, y }, color: ink, thickness: 1.5 });
    page.drawLine({ start: { x, y }, end: { x, y: y + dy * tick }, color: ink, thickness: 1.5 });
  }

  let cursorY = sheet.height - MARGIN_PT - 48;
  const left = MARGIN_PT + 24;
  const textWidth = contentWidth - 48;

  const write = (text: string, font: PDFFont, size: number, color = ink, gap = size + 8) => {
    page.drawText(fitToWidth(toWinAnsiSafe(text), font, size, textWidth), {
      x: left,
      y: cursorY,
      size,
      font,
      color,
    });
    cursorY -= gap;
  };

  write("Printio test print", bold, 26, ink, 40);
  write(
    "This page was sent from the Printio admin console to confirm this print queue works end to end.",
    regular,
    11,
    muted,
    28,
  );

  const rows: Array<[string, string]> = [
    ["Printer", input.printerName],
    ["Profile", input.profileLabel],
    ["Windows queue", input.windowsQueueName],
    ["Organization", input.organizationName],
    ["Sent by", input.sentBy],
    ["Sent at", formatTestPrintTimestamp(input.sentAt)],
    ["Paper size", input.paperSize],
  ];
  for (const [label, value] of rows) {
    page.drawText(fitToWidth(toWinAnsiSafe(label), regular, 10, 120), {
      x: left,
      y: cursorY,
      size: 10,
      font: regular,
      color: muted,
    });
    page.drawText(fitToWidth(toWinAnsiSafe(value), bold, 12, textWidth - 130), {
      x: left + 130,
      y: cursorY - 1,
      size: 12,
      font: bold,
      color: ink,
    });
    cursorY -= 24;
  }

  cursorY -= 12;
  page.drawText(fitToWidth(`Job id: ${toWinAnsiSafe(input.jobId)}`, mono, 9, textWidth), {
    x: left,
    y: cursorY,
    size: 9,
    font: mono,
    color: muted,
  });
  cursorY -= 26;

  write(
    "If you are holding this page, the whole path worked: Printio created the job, this printer's",
    regular,
    10,
    muted,
    14,
  );
  write("Agent collected it, and Windows printed it on the queue named above.", regular, 10, muted, 14);
  write(
    "It is marked as a test print, so it is not counted in anyone's quota or in usage reports.",
    regular,
    10,
    muted,
    14,
  );

  return doc.save();
}
