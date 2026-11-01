// Make labelled Hebrew test PDFs (no deps beyond what the repo already has) to check how the REAL printer's PDF
// interpreter handles Hebrew with different font embeddings. Then send each one with send-labelled.mjs.
//   node tools/raw-print/make-hebrew-tests.mjs [outDir]          (default: tools/raw-print/hebrew-out, gitignored)
//   node tools/raw-print/send-labelled.mjs hebrew-out/A-subset.pdf <printer-ip> "HEB A SUBSET" 'DUPLEX=OFF'
// Files:  A-subset.pdf (font subset embedded), B-full.pdf (whole font embedded), C-mixed.pdf (Hebrew + Latin + digits + nikud).
// Each page says in big Latin letters which file it is, so a garbled page is still identifiable. The Hebrew is
// written in visual order (reversed), as the booklet builder does, so a correct print reads right to left.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(path.resolve(import.meta.dirname, '../../apps/web/package.json'));
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const out = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, 'hebrew-out'));
mkdirSync(out, { recursive: true });

// David Libre Regular, the font the booklet builder bundles, read out of its base64 module.
const src = readFileSync(path.resolve(import.meta.dirname, '../../apps/web/lib/booklet/fonts/david-libre-regular.ts'), 'utf8');
const fontBytes = Buffer.from(/"([A-Za-z0-9+/=]{1000,})"/.exec(src)[1], 'base64');

const HEB_LINES = ['שלום עולם', 'ברוכים הבאים ללוח הלימוד', 'תניא - ליקוטי אמרים פרק א'];
const MIXED_LINES = ['שלום world 123', 'בְּרֵאשִׁית בָּרָא אֱלֹהִים', 'Page 7 - דף ז׳ (2026)'];
// Visual order for a right-to-left line: reverse the characters (good enough for a test page; keeps nikud off the
// reversal problem by only reversing the plain lines).
const visual = (s) => (/[֑-ׇ]/.test(s) ? s : [...s].reverse().join(''));

async function make(file, label, subset, lines) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset });
  for (let p = 1; p <= 2; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${label} page ${p}`, { x: 60, y: 720, size: 28, font, color: rgb(0.8, 0, 0) });
    lines.forEach((l, i) => page.drawText(visual(l), { x: 60, y: 640 - i * 60, size: 32, font }));
    page.drawText(`expected: 3 lines of Hebrew, readable, no boxes or wrong letters`, { x: 60, y: 60, size: 12, font });
  }
  const bytes = await doc.save();
  writeFileSync(path.join(out, file), bytes);
  console.log(file, bytes.length, 'bytes');
}
await make('A-subset.pdf', 'A SUBSET FONT', true, HEB_LINES);
await make('B-full.pdf', 'B FULL FONT', false, HEB_LINES);
await make('C-mixed.pdf', 'C MIXED+NIKUD', true, MIXED_LINES);
