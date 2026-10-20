// Send a PDF through packages/shared buildRawJob to the printer's raw port.
// usage: node send-built.mjs <pdf> <host> '<json options>'
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const { buildRawJob } = await import(pathToFileURL(path.join(root, 'packages/shared/src/pjl.ts')).href);
const [pdf, host, opts] = process.argv.slice(2);
const r = buildRawJob(JSON.parse(opts), readFileSync(pdf));
if (!r.ok) { console.error('HELD:', r.reason); process.exit(2); }
await new Promise((res, rej) => { const s = net.connect(9100, host, () => s.end(Buffer.from(r.bytes), res)); s.on('error', rej); });
console.log('sent', r.bytes.length, 'bytes', opts);
