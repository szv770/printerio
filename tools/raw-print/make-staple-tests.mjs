// Makes the small test PDFs for the staple-proving round (docs/staple-proving-plan.md).
// usage: node tools/raw-print/make-staple-tests.mjs          (writes to tools/raw-print/staple-out/)
// Each page says which way is up (a big TOP arrow and a ruler of corner words) so that, after the printer staples a set,
// it is obvious where the staple landed when you hold the sheet with the text upright. The *-rot180 files are the same
// pages stored upside down (page rotation 180): turn the printed sheet around and the text reads upright, and the staple
// that the printer put at the sheet's physical top-left is then at the reader's bottom-right.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(path.resolve(import.meta.dirname, '../../apps/web/package.json'));
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');

const outDir = path.resolve(import.meta.dirname, 'staple-out');
mkdirSync(outDir, { recursive: true });

async function build(name, pages, rotate) {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const plain = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    const p = doc.addPage([612, 792]); // US Letter portrait
    const { width: W, height: H } = p.getSize();
    p.drawRectangle({ x: 12, y: 12, width: W - 24, height: H - 24, borderColor: rgb(0, 0, 0), borderWidth: 2 });
    const mid = (t, size, y, font = bold) => p.drawText(t, { x: (W - font.widthOfTextAtSize(t, size)) / 2, y, size, font });
    mid('TOP', 120, H - 330);
    mid('(hold so this word is at the top)', 18, H - 365, plain);
    mid(`page ${n} of ${pages}`, 28, H / 2 - 40);
    mid(rotate ? 'stored UPSIDE DOWN on purpose (turn the sheet round to read it)' : 'stored upright', 16, H / 2 - 70, plain);
    p.drawText('TOP-LEFT', { x: 30, y: H - 34, size: 14, font: bold });
    p.drawText('TOP-RIGHT', { x: W - 30 - bold.widthOfTextAtSize('TOP-RIGHT', 14), y: H - 34, size: 14, font: bold });
    p.drawText('BOTTOM-LEFT', { x: 30, y: 24, size: 14, font: bold });
    p.drawText('BOTTOM-RIGHT', { x: W - 30 - bold.widthOfTextAtSize('BOTTOM-RIGHT', 14), y: 24, size: 14, font: bold });
    if (rotate) p.setRotation(degrees(180));
  }
  const bytes = await doc.save();
  const file = path.join(outDir, name);
  writeFileSync(file, bytes);
  console.log('wrote', path.relative(process.cwd(), file), `(${pages} page${pages === 1 ? '' : 's'}${rotate ? ', rotated 180' : ''})`);
}

// A staple needs at least two sheets: 2 pages single-sided = 2 sheets; 4 pages double-sided = 2 sheets.
await build('upright-2pages.pdf', 2, false);
await build('rot180-2pages.pdf', 2, true);
await build('upright-4pages.pdf', 4, false);
