import { inflateSync } from "node:zlib";

/**
 * Stops a "decompression bomb" before the PDF library opens the file. pdf-lib expands every compressed object stream
 * and cross-reference stream in memory the moment it parses a file, and a file a few kilobytes long can be built to
 * expand to many gigabytes, which would crash the server for everyone. Real object streams are small (kilobytes to a
 * few megabytes), so this expands ONLY those two kinds of stream with a hard output cap and refuses the file if one
 * (or all together) is over the cap. Images and page content are not expanded while opening, so they are not checked.
 *
 * It reads the file as plain bytes and runs nothing from it. A stream it cannot make sense of is skipped (the PDF
 * library then rejects or repairs it the way it always did).
 */

export const DEFAULT_MAX_STREAM_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export const INFLATE_REFUSAL = "This PDF is too large when opened (its compressed parts expand far beyond normal). Re-export or re-save it from the program that made it, then try again.";

export type InflationCheck = { ok: true } | { ok: false; reason: string };

/** Looks back from a `stream` keyword for the object's dictionary and says whether it is an object or cross-reference stream. */
function isExpandedOnOpen(buf: Buffer, streamKeywordAt: number): boolean {
  const window = buf.toString("latin1", Math.max(0, streamKeywordAt - 600), streamKeywordAt);
  const lastEnd = window.lastIndexOf("endobj");
  const dict = (lastEnd >= 0 ? window.slice(lastEnd + 6) : window).replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return /\/(ObjStm|XRef)(?![A-Za-z])/.test(dict);
}

export function checkPdfInflation(bytes: Uint8Array, opts: { maxStreamBytes?: number; maxTotalBytes?: number } = {}): InflationCheck {
  const maxStream = opts.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  let pos = 0;
  for (;;) {
    const at = buf.indexOf("stream", pos, "latin1");
    if (at < 0) return { ok: true };
    pos = at + 6;
    if (at >= 3 && buf.toString("latin1", at - 3, at) === "end") continue; // the "endstream" keyword
    let start = at + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const end = buf.indexOf("endstream", start, "latin1");
    if (end < 0) return { ok: true }; // truncated: nothing more to read
    pos = end + 9; // never scan inside the stream's own bytes
    if (!isExpandedOnOpen(buf, at)) continue;
    try {
      const out = inflateSync(buf.subarray(start, end), { maxOutputLength: Math.max(1, Math.min(maxStream, maxTotal - total)) });
      total += out.length;
      if (total >= maxTotal) return { ok: false, reason: INFLATE_REFUSAL };
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") return { ok: false, reason: INFLATE_REFUSAL };
      // Not valid compressed data: the PDF library deals with it.
    }
  }
}
