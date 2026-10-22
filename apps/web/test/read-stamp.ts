import { PDFArray, type PDFDocument, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";

/** All content-stream text of one page, decoded. */
export function pageContent(doc: PDFDocument, index: number): string {
  const node = doc.getPage(index).node;
  const contents = node.Contents();
  const refs: unknown[] = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  let out = "";
  for (const r of refs) {
    const obj = r instanceof PDFRef ? doc.context.lookup(r) : r;
    if (obj instanceof PDFRawStream) out += Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1") + "\n";
  }
  return out;
}

/** The stamp's text and text matrix, read back from the content stream (pdf-lib writes `a b c d e f Tm <hex> Tj`). */
export function readStamp(doc: PDFDocument, index: number) {
  const content = pageContent(doc, index);
  // The stamp is the only text drawn in 6.5pt grey (`g` fill) by pdf-lib: `<grey> g /Font 6.5 Tf ... a b c d e f Tm <hex> Tj`.
  const m = /[\d.]+ g\s+\/\S+ 6\.5 Tf\s+[\d.]+ TL\s+([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) Tm\s*<([0-9A-Fa-f]+)> Tj/.exec(content);
  if (!m) return null;
  const hex = m[7]!;
  let text = "";
  for (let i = 0; i < hex.length; i += 2) text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  const nums = m.slice(1, 7).map(Number);
  const a = nums[0]!;
  const b = nums[1]!;
  return { text, x: nums[4]!, y: nums[5]!, angle: Math.round((Math.atan2(b, a) * 180) / Math.PI + 360) % 360, content };
}

