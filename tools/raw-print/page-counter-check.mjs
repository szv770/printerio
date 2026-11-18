// Sends ONE 1-page test job (needs a one.pdf next to where you run it) and shows how the printer's page counter moves (INFO PAGECOUNT).
// Edit the host below. Prints a sheet of paper.
import net from 'node:net';
import { readFileSync } from 'node:fs';
const host = '192.168.100.168'; const UEL = '\x1b%-12345X';
const t0 = Date.now(); const log = (m) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
const count = () => new Promise((res) => { let o = ''; const q = net.connect(9100, host, () => q.write(`${UEL}@PJL\r\n@PJL INFO PAGECOUNT\r\n${UEL}`)); q.on('data', (d) => (o += d.toString('latin1'))); q.on('error', () => res(null)); setTimeout(() => { q.destroy(); res(Number((/PAGECOUNT\s+(\d+)/.exec(o) || [])[1]) || null); }, 1500); });
const c0 = await count(); log('counter before: ' + c0);
const pdf = readFileSync('one.pdf'); const name = 'COUNTER test ' + Date.now().toString(36);
const head = `${UEL}@PJL\r\n@PJL JOB NAME="${name}"\r\n@PJL SET DUPLEX=OFF\r\n@PJL SET QTY=1\r\n@PJL ENTER LANGUAGE=PDF\r\n`;
await new Promise((res) => { const s = net.connect(9100, host, () => s.end(Buffer.concat([Buffer.from(head, 'latin1'), pdf, Buffer.from(`\r\n${UEL}@PJL EOJ NAME="${name}"\r\n${UEL}`, 'latin1')]), res)); s.on('error', () => res()); });
log('sent 1-page job and closed');
for (const wait of [12000, 8000, 10000]) { await new Promise((r) => setTimeout(r, wait)); const c = await count(); log(`counter: ${c}  (delta ${c - c0})`); if (c - c0 >= 1) break; }
process.exit(0);
