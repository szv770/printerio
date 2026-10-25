// Build a labelled test booklet from a PDF using the app's imposeBookletPdf.
// usage: node make-booklet-test.mjs <in.pdf> <out.pdf> <left|right> <label> [portrait|landscape] [normal|reversed] [letter|tabloid|a4|a3] [fill|keep]
// sheet = the paper the booklet is printed on (default letter = half-size pages). tabloid = 11x17: Letter pages come out
// at about full size. fit fill (default) crops each page's blank margins first; keep scales the whole page.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/web/package.json'));
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { imposeBookletPdf } = await import(pathToFileURL(path.join(root, 'apps/web/lib/pdf/imposition.ts')).href);
const [inp, out, side, label, orient = 'portrait', order = 'normal', sheetName = 'letter', fit = 'fill'] = process.argv.slice(2);
const SHEETS = { letter: [612, 792], tabloid: [792, 1224], a4: [595.28, 841.89], a3: [841.89, 1190.55] };
const sheet = SHEETS[sheetName];
if (!sheet) throw new Error(`unknown sheet ${sheetName}; use ${Object.keys(SHEETS).join('|')}`);
if (fit !== 'fill' && fit !== 'keep') throw new Error('fit must be fill or keep');
const src = await PDFDocument.load(readFileSync(inp));
while (src.getPageCount() % 4) src.addPage([612, 792]);
const font = await src.embedFont(StandardFonts.HelveticaBold);
const p1 = src.getPage(0);
p1.drawText(label, { x: 20, y: p1.getHeight() - 40, size: 28, font, color: rgb(1, 0, 0) });
let bytes = await imposeBookletPdf(new Uint8Array(await src.save()), { width: sheet[0], height: sheet[1] }, side, { fit });
if (order === 'reversed') {
  // reverse SHEET order (keep front/back pairs together): innermost sheet first
  const d = await PDFDocument.load(bytes), r = await PDFDocument.create();
  const n = d.getPageCount(), idx = [];
  for (let s = n / 2 - 1; s >= 0; s--) idx.push(2 * s, 2 * s + 1);
  for (const pg of await r.copyPages(d, idx)) r.addPage(pg);
  bytes = await r.save();
}
if (orient === 'portrait') {
  // physically portrait sheets with the landscape spread rotated 90deg (like the driver / Chromium output)
  const ld = await PDFDocument.load(bytes), pd = await PDFDocument.create();
  const emb = await pd.embedPages(ld.getPages());
  emb.forEach((e, i) => { const pg = pd.addPage([sheet[0], sheet[1]]); pg.drawPage(e, { x: sheet[0], y: 0, rotate: degrees(90) }); });
  bytes = await pd.save();
}
writeFileSync(out, bytes);
console.log(out, side, orient, sheetName, fit, 'pages', (await PDFDocument.load(bytes)).getPageCount());
