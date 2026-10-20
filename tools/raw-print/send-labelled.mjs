// Stamp a label on page 1 of a PDF, then send it with explicit PJL SET lines (diagnostics).
// usage: node send-labelled.mjs <in.pdf> <host> <label> 'KEY=VAL' 'KEY=VAL' ...
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
const require = createRequire(path.resolve(import.meta.dirname, '../../apps/web/package.json'));
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const [inp, host, label, ...sets] = process.argv.slice(2);
const d = await PDFDocument.load(readFileSync(inp));
const f = await d.embedFont(StandardFonts.HelveticaBold);
const p = d.getPage(0);
p.drawText(label, { x: 60, y: p.getHeight() - 60, size: 40, font: f, color: rgb(1, 0, 0) });
const pdf = await d.save();
const U = '\x1b%-12345X';
let h = `${U}@PJL\r\n@PJL JOB NAME="${label.replace(/[^\w .-]/g, '')}"\r\n`;
for (const s of sets) h += `@PJL SET ${s}\r\n`;
h += '@PJL ENTER LANGUAGE=PDF\r\n';
const buf = Buffer.concat([Buffer.from(h, 'latin1'), Buffer.from(pdf), Buffer.from(`\r\n${U}@PJL EOJ\r\n${U}`, 'latin1')]);
await new Promise((res, rej) => { const s = net.connect(9100, host, () => s.end(buf, res)); s.on('error', rej); });
console.log('sent', label, sets.join(' '), `(${p.getWidth()}x${p.getHeight()}, rot ${p.getRotation().angle})`);
