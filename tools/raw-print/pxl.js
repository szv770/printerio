// Minimal PCL XL tokenizer: prints BeginPage/EndPage attrs and per-page summary.
const fs = require('fs');
const f = process.argv[2];
const buf = fs.readFileSync(f);
let p = buf.indexOf('ENTER LANGUAGE=PCLXL');
p = buf.indexOf(0x0a, p) + 1;
const hdrEnd = buf.indexOf(0x0a, p) + 1; // ") HP-PCL XL;..." line
console.log('stream header:', buf.slice(p, hdrEnd).toString('latin1').trim());
p = hdrEnd;
const NAMES = { 0x25: 'MediaSize', 0x26: 'MediaSource', 0x27: 'MediaType', 0x28: 'Orientation', 0x29: 'PageAngle', 0x2a: 'PageOrigin', 0x2b: 'PageScale', 0x2f: 'CustomMediaSize', 0x30: 'CustomMediaSizeUnits', 0x31: 'PageCopies', 0x34: 'SimplexPageMode', 0x35: 'DuplexPageMode', 0x36: 'DuplexPageSide', 0x89: 'Measure', 0x86: 'UnitsPerMeasure', 0x8f: 'ErrorReport' };
const OPS = { 0x41: 'BeginSession', 0x42: 'EndSession', 0x43: 'BeginPage', 0x44: 'EndPage', 0x47: 'Comment', 0x48: 'OpenDataSource', 0x49: 'CloseDataSource' };
const scal = { 0xc0: 1, 0xc1: 2, 0xc2: 4, 0xc3: 2, 0xc4: 4, 0xc5: 4 };
function rd(t, o) {
  switch (t & 0x0f) { case 0: return buf.readUInt8(o); case 1: return buf.readUInt16LE(o); case 2: return buf.readUInt32LE(o);
    case 3: return buf.readInt16LE(o); case 4: return buf.readInt32LE(o); case 5: return +buf.readFloatLE(o).toFixed(2); }
}
const esz = [1, 2, 4, 2, 4, 4];
let attrs = [], vals = [], pages = [], cur = null, ops = 0;
while (p < buf.length) {
  const t = buf[p];
  if (t >= 0xc0 && t <= 0xc5) { vals.push(rd(t, p + 1)); p += 1 + scal[t]; }
  else if (t >= 0xc8 && t <= 0xcd) { const lt = buf[p + 1]; const n = rd(lt, p + 2); const s = p + 2 + scal[lt]; const k = esz[t - 0xc8];
    vals.push(n <= 8 ? Array.from({ length: n }, (_, i) => rd(t - 8, s + i * k)) : `[${n}]`); p = s + n * k; }
  else if (t >= 0xd0 && t <= 0xd5) { const k = esz[t - 0xd0]; vals.push([rd(t - 0x10, p + 1), rd(t - 0x10, p + 1 + k)]); p += 1 + 2 * k; }
  else if (t >= 0xe0 && t <= 0xe5) { const k = esz[t - 0xe0]; vals.push([0, 1, 2, 3].map(i => rd(t - 0x20, p + 1 + i * k))); p += 1 + 4 * k; }
  else if (t === 0xf8) { attrs.push([buf[p + 1], vals.pop()]); p += 2; }
  else if (t === 0xf9) { attrs.push([buf.readUInt16LE(p + 1), vals.pop()]); p += 3; }
  else if (t === 0xfa) { const n = buf.readUInt32LE(p + 1); if (cur) cur.data += n; p += 5 + n; }
  else if (t === 0xfb) { const n = buf[p + 1]; if (cur) cur.data += n; p += 2 + n; }
  else if (t >= 0x41 && t <= 0xbf) {
    ops++;
    if (t === 0x43) { cur = { n: pages.length + 1, begin: attrs.map(([a, v]) => `${NAMES[a] || '0x' + a.toString(16)}=${JSON.stringify(v)}`).join(' '), data: 0, ops: 0, off: p }; pages.push(cur); }
    if (cur) cur.ops++;
    if (t === 0x44) cur = null;
    if (t === 0x41 || t === 0x42) console.log(OPS[t], attrs.map(([a, v]) => `0x${a.toString(16)}=${JSON.stringify(v)}`).join(' '));
    attrs = []; vals = [];
    p++;
  } else if (t === 0x1b) { console.log('ESC/UEL at', p, buf.slice(p, p + 60).toString('latin1').replace(/[^\x20-\x7e]/g, '.')); break; }
  else if (t === 0x20 || t === 0x0a || t === 0x0d || t === 0x00 || t === 0x09) p++;
  else { console.log('unknown tag 0x' + t.toString(16), 'at', p); break; }
}
for (const pg of pages) console.log(`page ${pg.n} @${pg.off}: ${pg.begin} | ops=${pg.ops} data=${pg.data}`);
