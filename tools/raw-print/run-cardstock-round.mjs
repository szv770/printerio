// Sends ONE cardstock test job: one page, single-sided, MEDIATYPE=CARDSTOCK, labelled. Models run-staple-round.mjs.
// usage:  node tools/raw-print/run-cardstock-round.mjs [printer-ip] --bypass-is-loaded
//         (default printer 192.168.100.168; without --bypass-is-loaded it only shows what it WOULD send and sends nothing)
//
// SAFETY: the printer WAITS for paper if the bypass tray is empty (or holds another size/type) and every later job queues
// behind it until someone cancels at the printer's panel. So: put ONE sheet of Letter cardstock in the BYPASS tray first,
// run this once, and watch the printer. Send ONE job only; do not run it again until you have looked at the paper.
//
// What to look for: the page comes out of the BYPASS tray (not TRAY1-4), printed single-sided, "CARDSTOCK TEST" in red.
// Then record the result in docs/kyocera-raw-print.md ("Labelled tests") and, if it worked, flip the UNPROVEN note on
// MEDIATYPE_CARDSTOCK_UNPROVEN in packages/shared/src/pjl.ts and the FEATURES.md row. If the page never comes out, or a
// different tray/type is needed, change only that one constant (the value below must match it).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const here = import.meta.dirname;
const MEDIATYPE = 'MEDIATYPE=CARDSTOCK'; // = MEDIATYPE_CARDSTOCK_UNPROVEN in packages/shared/src/pjl.ts
const SETTINGS = ['DUPLEX=OFF', MEDIATYPE];
const LABEL = 'CARDSTOCK TEST';

const args = process.argv.slice(2);
const confirmed = args.includes('--bypass-is-loaded');
const host = args.find((a) => !a.startsWith('--')) ?? '192.168.100.168';
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
  console.error('The printer address must look like 192.168.100.168');
  process.exit(2);
}

console.log(`Cardstock test for ${host}: ONE job, ONE page.`);
console.log(`Settings (this one job only): ${SETTINGS.join(' ')}`);
if (!confirmed) {
  console.log('');
  console.log('Nothing was sent. The printer waits (and holds up everyone) if the bypass tray is empty.');
  console.log('Load one sheet of Letter cardstock in the BYPASS tray, then run it again with --bypass-is-loaded');
  process.exit(0);
}

const require = createRequire(path.resolve(here, '../../apps/web/package.json'));
const { PDFDocument, StandardFonts } = require('pdf-lib');
const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('Cardstock test page', { x: 72, y: 700, size: 24, font });
page.drawText('Should come out of the BYPASS tray.', { x: 72, y: 660, size: 14, font });
const dir = mkdtempSync(path.join(os.tmpdir(), 'printio-cardstock-'));
const pdf = path.join(dir, 'cardstock-1page.pdf');
writeFileSync(pdf, await doc.save());

const r = spawnSync(process.execPath, [path.join(here, 'send-labelled.mjs'), pdf, host, LABEL, ...SETTINGS], { stdio: 'inherit' });
process.exit(r.status ?? 1);
