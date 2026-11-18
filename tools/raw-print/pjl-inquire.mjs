// Read-only: asks the printer a few PJL questions and prints the reply (nothing is printed on paper).
// usage: node tools/raw-print/pjl-inquire.mjs <printer-ip> "INFO ID" "INFO STATUS" "INFO PAGECOUNT" "INFO CONFIG" "INFO VARIABLES"
// Note: every connection may show as an entry in the printer's own job log, so ask sparingly.
import net from 'node:net';
const [host, ...cmds] = process.argv.slice(2);
const UEL = '\x1b%-12345X';
const s = net.connect(9100, host, () => s.write(UEL + '@PJL\r\n' + cmds.map((c) => `@PJL ${c}\r\n`).join('') + UEL));
let out = ''; s.on('data', (d) => (out += d.toString('latin1'))); s.on('error', (e) => console.log('ERR', e.message));
setTimeout(() => { console.log(out.replace(/\f/g, '\n---\n')); process.exit(0); }, 7000);
