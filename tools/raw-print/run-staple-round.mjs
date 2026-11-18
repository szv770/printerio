// Sends ONE staple test set (see docs/staple-proving-plan.md) with a short typed command.
// usage: node tools/raw-print/run-staple-round.mjs <1|2|3|4> [printer-ip]      (default printer 192.168.100.168)
// It only runs tools/raw-print/send-labelled.mjs with the exact settings listed in the plan; nothing else is sent.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const out = path.join(here, 'staple-out');
const sets = {
  1: { file: 'upright-2pages.pdf', label: 'S1 TWO STAPLES TOP', pjl: ['DUPLEX=OFF', 'OUTBIN=OPTIONFACEDOWN', 'STAPLEOPTION=TWO', 'KFEEDEDGE=SHORTEDGE', 'FINISH=STAPLE'] },
  2: { file: 'rot180-2pages.pdf', label: 'S2 BOTTOM RIGHT TURNED', pjl: ['DUPLEX=OFF', 'OUTBIN=OPTIONFACEDOWN', 'STAPLEOPTION=ONE', 'FINISH=STAPLE'] },
  3: { file: 'upright-4pages.pdf', label: 'S3 DUPLEX TWO STAPLES', pjl: ['DUPLEX=ON', 'BINDING=LONGEDGE', 'OUTBIN=OPTIONFACEDOWN', 'STAPLEOPTION=TWO', 'KFEEDEDGE=LONGEDGE', 'FINISH=STAPLE'] },
  4: { file: 'rot180-2pages.pdf', label: 'S4 TWO STAPLES RIGHT TURNED', pjl: ['DUPLEX=OFF', 'OUTBIN=OPTIONFACEDOWN', 'STAPLEOPTION=TWO', 'FINISH=STAPLE'] },
};

const n = process.argv[2];
const host = process.argv[3] ?? '192.168.100.168';
const set = sets[n];
if (!set) {
  console.error('Say which set: 1, 2, 3 or 4.  Example: node tools/raw-print/run-staple-round.mjs 1');
  process.exit(2);
}
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
  console.error('The printer address must look like 192.168.100.168');
  process.exit(2);
}
const pdf = path.join(out, set.file);
if (!existsSync(pdf)) {
  console.error('The test pages are not made yet. First run:  node tools/raw-print/make-staple-tests.mjs');
  process.exit(2);
}
console.log(`Sending set S${n} to ${host}: ${set.label}`);
console.log(`Settings (this one job only): ${set.pjl.join(' ')}`);
const r = spawnSync(process.execPath, [path.join(here, 'send-labelled.mjs'), pdf, host, set.label, ...set.pjl], { stdio: 'inherit' });
process.exit(r.status ?? 1);
