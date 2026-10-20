#!/usr/bin/env node
// Printio Phase 0 spike: a fake IPP printer that accepts anything and records what each
// device sends. No dependencies. See README.md. Not production code.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { attr, decodeIpp, encodeIpp, flatten, OP, OP_NAMES, STATUS, TAG } from './ipp.mjs';

const MAX_BODY = 200 * 1024 * 1024;
const SIZES = [
  { key: 'iso_a4_210x297mm', x: 21000, y: 29700 },
  { key: 'na_letter_8.5x11in', x: 21590, y: 27940 },
  { key: 'iso_a3_297x420mm', x: 29700, y: 42000 },
];

const MAGICS = [
  ['pdf', (b) => b.subarray(0, 5).toString() === '%PDF-'],
  ['pwg-raster', (b) => b.subarray(0, 4).toString() === 'RaS2'],
  ['apple-urf', (b) => b.subarray(0, 8).toString() === 'UNIRAST\0'],
  ['jpeg', (b) => b[0] === 0xff && b[1] === 0xd8],
  ['zip/oxps', (b) => b[0] === 0x50 && b[1] === 0x4b],
  ['pjl/pcl', (b) => b[0] === 0x1b],
  ['postscript', (b) => b.subarray(0, 2).toString() === '%!'],
];
const detect = (b) => (b.length ? (MAGICS.find(([, f]) => f(b))?.[0] ?? 'unknown') : 'empty');
const EXT = { pdf: 'pdf', 'pwg-raster': 'pwg', 'apple-urf': 'urf', jpeg: 'jpg', 'zip/oxps': 'oxps', postscript: 'ps' };

export function createSpike({ dataDir, publicBase, formats, openMode = false }) {
  fs.mkdirSync(path.join(dataDir, 'jobs'), { recursive: true });
  const tokenFile = path.join(dataDir, 'token');
  const token =
    process.env.SPIKE_TOKEN ||
    (fs.existsSync(tokenFile)
      ? fs.readFileSync(tokenFile, 'utf8').trim()
      : (() => {
          const t = crypto.randomBytes(12).toString('hex');
          fs.writeFileSync(tokenFile, t);
          return t;
        })());
  const logFile = path.join(dataDir, 'requests.jsonl');
  const jobs = new Map();
  let nextJobId = 1;
  const startedAt = Date.now();
  const uuid = `urn:uuid:${crypto.createHash('sha1').update(token).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5')}`;

  const redact = (s) => s.split(token).join('<token>');
  const log = (entry) => fs.appendFileSync(logFile, `${redact(JSON.stringify(entry))}\n`);

  function baseUrl(req) {
    if (publicBase) return publicBase.replace(/\/$/, '');
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${req.headers.host}`;
  }

  function mediaCol(s) {
    return [
      { name: 'media-size', tag: TAG.begCollection, values: [[
        { name: 'x-dimension', tag: TAG.integer, values: [s.x] },
        { name: 'y-dimension', tag: TAG.integer, values: [s.y] },
      ]] },
    ];
  }

  function printerAttrs(req) {
    const uri = `${baseUrl(req)}/p/${token}`;
    const secure = uri.startsWith('https');
    const dpi600 = { x: 600, y: 600, units: 3 };
    return [
      attr(TAG.uri, 'printer-uri-supported', uri),
      attr(TAG.keyword, 'uri-security-supported', secure ? 'tls' : 'none'),
      attr(TAG.keyword, 'uri-authentication-supported', 'none'),
      attr(TAG.name, 'printer-name', 'Printio'),
      attr(TAG.text, 'printer-info', 'Printio cloud print (spike)'),
      attr(TAG.text, 'printer-location', ''),
      attr(TAG.text, 'printer-make-and-model', 'Printio Cloud Print'),
      attr(TAG.text, 'printer-device-id', 'MFG:Printio;MDL:Cloud Print;CMD:PDF;'),
      attr(TAG.uri, 'printer-uuid', uuid),
      attr(TAG.uri, 'printer-more-info', `${baseUrl(req)}/setup/${token}`),
      attr(TAG.enum, 'printer-state', 3),
      attr(TAG.keyword, 'printer-state-reasons', 'none'),
      attr(TAG.boolean, 'printer-is-accepting-jobs', true),
      attr(TAG.integer, 'queued-job-count', 0),
      attr(TAG.integer, 'printer-up-time', Math.floor((Date.now() - startedAt) / 1000) + 1),
      attr(TAG.dateTime, 'printer-current-time', new Date()),
      attr(TAG.keyword, 'ipp-versions-supported', '1.1', '2.0'),
      attr(TAG.keyword, 'ipp-features-supported', 'ipp-everywhere'),
      attr(TAG.enum, 'operations-supported', ...Object.values(OP)),
      attr(TAG.charset, 'charset-configured', 'utf-8'),
      attr(TAG.charset, 'charset-supported', 'utf-8'),
      attr(TAG.language, 'natural-language-configured', 'en'),
      attr(TAG.language, 'generated-natural-language-supported', 'en'),
      attr(TAG.mime, 'document-format-default', formats[0]),
      attr(TAG.mime, 'document-format-supported', ...formats),
      attr(TAG.keyword, 'pdl-override-supported', 'attempted'),
      attr(TAG.keyword, 'compression-supported', 'none'),
      attr(TAG.boolean, 'multiple-document-jobs-supported', false),
      attr(TAG.integer, 'copies-default', 1),
      attr(TAG.range, 'copies-supported', [1, 99]),
      attr(TAG.keyword, 'sides-default', 'one-sided'),
      attr(TAG.keyword, 'sides-supported', 'one-sided', 'two-sided-long-edge', 'two-sided-short-edge'),
      attr(TAG.enum, 'orientation-requested-default', 3),
      attr(TAG.enum, 'orientation-requested-supported', 3, 4, 5, 6),
      attr(TAG.enum, 'print-quality-default', 4),
      attr(TAG.enum, 'print-quality-supported', 4),
      attr(TAG.keyword, 'print-color-mode-default', 'monochrome'),
      attr(TAG.keyword, 'print-color-mode-supported', 'monochrome'),
      attr(TAG.keyword, 'print-scaling-default', 'auto'),
      attr(TAG.keyword, 'print-scaling-supported', 'auto', 'fit', 'fill', 'none'),
      attr(TAG.boolean, 'page-ranges-supported', true),
      attr(TAG.integer, 'number-up-default', 1),
      attr(TAG.integer, 'number-up-supported', 1),
      attr(TAG.enum, 'finishings-default', 3),
      attr(TAG.enum, 'finishings-supported', 3),
      attr(TAG.resolution, 'printer-resolution-default', dpi600),
      attr(TAG.resolution, 'printer-resolution-supported', dpi600),
      attr(TAG.keyword, 'media-default', SIZES[0].key),
      attr(TAG.keyword, 'media-supported', ...SIZES.map((s) => s.key)),
      attr(TAG.keyword, 'media-ready', SIZES[0].key),
      attr(TAG.begCollection, 'media-col-default', mediaCol(SIZES[0])),
      attr(TAG.begCollection, 'media-col-ready', mediaCol(SIZES[0])),
      attr(TAG.begCollection, 'media-col-database', ...SIZES.map(mediaCol)),
      attr(TAG.keyword, 'media-col-supported', 'media-size'),
      attr(TAG.keyword, 'job-creation-attributes-supported',
        'copies', 'sides', 'media', 'media-col', 'orientation-requested', 'print-quality',
        'print-color-mode', 'print-scaling', 'page-ranges', 'printer-resolution', 'finishings'),
      attr(TAG.resolution, 'pwg-raster-document-resolution-supported', { x: 300, y: 300, units: 3 }, dpi600),
      attr(TAG.keyword, 'pwg-raster-document-type-supported', 'sgray_8'),
      attr(TAG.keyword, 'pwg-raster-document-sheet-back', 'normal'),
    ];
  }

  function jobAttrs(req, job) {
    return [
      attr(TAG.integer, 'job-id', job.id),
      attr(TAG.uri, 'job-uri', `${baseUrl(req)}/p/${token}/jobs/${job.id}`),
      attr(TAG.enum, 'job-state', job.state),
      attr(TAG.keyword, 'job-state-reasons', job.state === 9 ? 'job-completed-successfully' : 'none'),
      attr(TAG.name, 'job-name', job.name),
      attr(TAG.name, 'job-originating-user-name', job.user),
      attr(TAG.integer, 'job-k-octets', Math.ceil(job.bytes / 1024)),
    ];
  }

  function saveDoc(job, doc) {
    const magic = detect(doc);
    const safe = job.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'job';
    const file = path.join(dataDir, 'jobs', `${String(job.id).padStart(4, '0')}-${safe}.${EXT[magic] ?? 'bin'}`);
    fs.writeFileSync(file, doc);
    job.bytes = doc.length;
    job.state = 9;
    return { magic, file: path.relative(dataDir, file) };
  }

  function handleIpp(req, body) {
    const msg = decodeIpp(body);
    const opAttrs = flatten(msg.groups.find((g) => g.tag === TAG.operation));
    const jobTemplate = flatten(msg.groups.find((g) => g.tag === TAG.job));
    const opName = OP_NAMES[msg.code] ?? `0x${msg.code.toString(16)}`;
    const entry = {
      t: new Date().toISOString(),
      ua: req.headers['user-agent'],
      ip: req.headers['cf-connecting-ip'] || req.socket.remoteAddress,
      ippVersion: msg.version,
      path: req.url,
      op: opName,
      opAttrs,
      jobTemplate,
      docBytes: msg.doc.length,
    };
    const version = ['1.1', '2.0', '2.1', '2.2'].includes(msg.version) ? msg.version : '2.0';
    const head = [attr(TAG.charset, 'attributes-charset', 'utf-8'), attr(TAG.language, 'attributes-natural-language', 'en')];
    let status = STATUS.ok;
    const groups = [{ tag: TAG.operation, attrs: head }];

    switch (msg.code) {
      case OP.getPrinterAttributes: {
        const wanted = opAttrs['requested-attributes'];
        const set = wanted ? new Set([].concat(wanted)) : null;
        const all = !set || ['all', 'printer-description', 'job-template'].some((k) => set.has(k));
        groups.push({ tag: TAG.printer, attrs: printerAttrs(req).filter((a) => all || set.has(a.name)) });
        break;
      }
      case OP.validateJob:
        break;
      case OP.printJob:
      case OP.createJob: {
        const job = {
          id: nextJobId++,
          name: String(opAttrs['job-name'] ?? 'untitled'),
          user: String(opAttrs['requesting-user-name'] ?? 'unknown'),
          format: opAttrs['document-format'] ?? null,
          state: 3,
          bytes: 0,
        };
        jobs.set(job.id, job);
        if (msg.code === OP.printJob) Object.assign(entry, saveDoc(job, msg.doc), { jobId: job.id });
        entry.jobId = job.id;
        groups.push({ tag: TAG.job, attrs: jobAttrs(req, job) });
        break;
      }
      case OP.sendDocument: {
        const job = jobs.get(Number(opAttrs['job-id']));
        if (!job) { status = STATUS.notFound; break; }
        Object.assign(entry, saveDoc(job, msg.doc), { jobId: job.id, format: opAttrs['document-format'] });
        groups.push({ tag: TAG.job, attrs: jobAttrs(req, job) });
        break;
      }
      case OP.getJobAttributes: {
        const job = jobs.get(Number(opAttrs['job-id']));
        if (!job) { status = STATUS.notFound; break; }
        groups.push({ tag: TAG.job, attrs: jobAttrs(req, job) });
        break;
      }
      case OP.getJobs: {
        const done = opAttrs['which-jobs'] === 'completed';
        for (const job of jobs.values()) {
          if (done && job.state === 9) groups.push({ tag: TAG.job, attrs: jobAttrs(req, job) });
        }
        break;
      }
      case OP.cancelJob:
        break;
      default:
        status = STATUS.operationNotSupported;
    }
    entry.status = status;
    log(entry);
    return encodeIpp({ version, code: status, requestId: msg.requestId, groups });
  }

  function report() {
    let lines;
    try {
      lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return 'No requests recorded yet.\n';
    }
    const byUa = new Map();
    for (const e of lines) {
      const k = e.ua ?? '(no user-agent)';
      if (!byUa.has(k)) byUa.set(k, []);
      byUa.get(k).push(e);
    }
    const out = [`Printio IPP spike report - ${lines.length} requests, ${byUa.size} distinct clients\n`];
    for (const [ua, es] of byUa) {
      out.push(`== ${ua}`);
      out.push(`   ops: ${[...new Set(es.map((e) => e.op))].join(', ')}`);
      out.push(`   paths used: ${[...new Set(es.map((e) => e.path).filter(Boolean))].join(', ') || '(not recorded)'}`);
      // Create-Job carries the job name and options; Send-Document carries the file. Join them.
      const created = new Map(es.filter((x) => x.op === 'createJob').map((x) => [x.jobId, x]));
      for (const e of es.filter((x) => x.op === 'printJob' || x.op === 'sendDocument')) {
        const c = created.get(e.jobId) ?? e;
        out.push(`   JOB ${e.jobId}: declared format=${e.opAttrs['document-format'] ?? e.format ?? '?'} actual=${e.magic} bytes=${e.docBytes}`);
        out.push(`      name=${c.opAttrs['job-name']}  options=${JSON.stringify(c.jobTemplate)}`);
      }
      const first = es[0];
      out.push(`   first seen ${first.t} from ${first.ip}, IPP ${first.ippVersion}`);
      out.push('');
    }
    return out.join('\n');
  }

  function setupPage(req) {
    const base = baseUrl(req);
    const hostOnly = new URL(base).hostname;
    const port = new URL(base).port || (base.startsWith('https') ? '443' : '80');
    const url = `${base}/p/${token}`;
    const ipps = `ipps://${hostOnly}:${port}/p/${token}`;
    const ua = String(req.headers['user-agent'] ?? '');
    const detected = /iPhone|iPad|iPod/.test(ua) ? 'ios'
      : /Android/.test(ua) ? 'android'
      : /CrOS/.test(ua) ? 'chromeos'
      : /Windows/.test(ua) ? 'windows'
      : /Macintosh|Mac OS X/.test(ua) ? 'mac' : '';
    const steps = (items) => `<ol class=steps>${items.map((t) => `<li>${t}</li>`).join('')}</ol>`;
    const sections = {
      ios: {
        title: 'iPhone or iPad',
        body: `
<p class=note><b>Use Safari</b> (the blue compass icon). Chrome and other apps cannot install this. If you opened this page somewhere else, tap Share, then &ldquo;Open in Safari&rdquo;.</p>
<p><a class=btn href="/profile/${token}.mobileconfig">1. Download the iPhone setup profile</a></p>
${steps([
  'Tap the button above. A box says <i>&ldquo;This website is trying to download a configuration profile&rdquo;</i>. Tap <b>Allow</b>, then tap <b>Close</b>.',
  'Open the <b>Settings</b> app (gray gear). At the very <b>top</b> of Settings, just under your name, tap the new row <b>Profile Downloaded</b>.<br><small>Not there? Go to Settings &rarr; General &rarr; scroll down &rarr; <b>VPN &amp; Device Management</b> &rarr; under &ldquo;Downloaded Profile&rdquo; tap <b>Printio printer</b>.</small>',
  'Tap <b>Install</b> (top right) and enter your iPhone passcode.',
  'A warning says <i>&ldquo;Unsigned Profile&rdquo;</i>. That is normal. Tap <b>Install</b> (top right) again, then <b>Install</b> at the bottom, then <b>Done</b>.',
  'To print: open a photo, PDF or webpage, tap the <b>Share</b> button (square with an arrow), scroll down and tap <b>Print</b>, tap <b>Printer</b>, and choose <b>Printio</b>. If it is not listed, wait 10 seconds and tap Printer again.',
])}
<p><small>To remove it later: Settings &rarr; General &rarr; VPN &amp; Device Management &rarr; Printio printer &rarr; Remove Profile. Menu names can differ a little between iOS versions. If you get stuck, tell Claude the step number.</small></p>`,
      },
      android: {
        title: 'Android phone',
        body: steps([
          'Open <b>Settings</b> &rarr; <b>Connected devices</b> &rarr; <b>Connection preferences</b> &rarr; <b>Printing</b> &rarr; <b>Default Print Service</b>.',
          'Tap the <b>&#8942;</b> menu (top right) &rarr; <b>Add printer</b>.',
          `Type this address exactly (no <code>https://</code>, no slashes): <code>${hostOnly}</code>`,
          'Tap <b>Add</b> (or Save). Printio now appears in every app&rsquo;s print menu.',
          'To print: open a document or photo &rarr; &#8942; or Share &rarr; <b>Print</b> &rarr; choose <b>Printio</b>.',
        ]),
      },
      windows: {
        title: 'Windows 10 / 11',
        body: steps([
          'Open <b>Settings</b> &rarr; <b>Bluetooth &amp; devices</b> &rarr; <b>Printers &amp; scanners</b> &rarr; <b>Add device</b>.',
          'Wait a few seconds, then click <b>Add manually</b>.',
          `Choose <b>Select a shared printer by name</b> and paste: <code>${url}</code>`,
          'Click <b>Next</b>. If asked for a driver choose <b>Microsoft IPP Class Driver</b>. Click <b>Next</b>, then <b>Finish</b>.',
        ]),
      },
      mac: {
        title: 'Mac',
        body: steps([
          'Easiest: open <b>Terminal</b> and paste this one line:<br><code>lpadmin -p Printio -E -v ${IPPS} -m everywhere</code>'.replace('${IPPS}', ipps),
          `Or: <b>System Settings</b> &rarr; <b>Printers &amp; Scanners</b> &rarr; <b>Add Printer</b> &rarr; the <b>IP</b> tab. Protocol <b>IPP</b>, Address <code>${hostOnly}:${port}</code>, Queue <code>p/${token}</code>.`,
        ]),
      },
      chromeos: {
        title: 'Chromebook',
        body: steps([
          'Open <b>Settings</b> &rarr; <b>Advanced</b> &rarr; <b>Printing</b> &rarr; <b>Printers</b> &rarr; <b>Add printer manually</b>.',
          `Address <code>${hostOnly}:${port}</code>, Protocol <b>IPPS</b>, Queue <code>p/${token}</code>. Name it Printio and Add.`,
        ]),
      },
    };
    const order = [detected, 'ios', 'android', 'windows', 'mac', 'chromeos'].filter((k, i, a) => k && a.indexOf(k) === i);
    const blocks = order.map((k) => `<details${k === detected ? ' open' : ''} id="${k}"><summary>${sections[k].title}${k === detected ? ' <em>(your device)</em>' : ''}</summary>${sections[k].body}</details>`).join('\n');
    return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Add Printio printer</title>
<style>
body{font:18px/1.5 system-ui,-apple-system,sans-serif;max-width:40rem;margin:1rem auto;padding:0 1rem;color:#111}
code{background:#eee;padding:.1em .35em;border-radius:.3em;word-break:break-all;font-size:.9em}
details{border:1px solid #ccc;border-radius:.7rem;margin:.8rem 0;padding:.2rem 1rem}
summary{font-weight:700;font-size:1.15rem;padding:.7rem 0;cursor:pointer}summary em{font-weight:400;color:#555}
.btn{display:block;text-align:center;background:#111;color:#fff;padding:1rem;border-radius:.7rem;text-decoration:none;font-weight:700;margin:1rem 0}
.steps{counter-reset:s;list-style:none;padding:0}.steps li{counter-increment:s;position:relative;padding:.4rem 0 .9rem 2.6rem}
.steps li:before{content:counter(s);position:absolute;left:0;top:.35rem;width:1.9rem;height:1.9rem;border-radius:50%;background:#111;color:#fff;text-align:center;line-height:1.9rem;font-weight:700}
.note{background:#fff7d6;border-radius:.6rem;padding:.7rem .9rem}small{color:#444}
</style>
<h1>Add the Printio printer</h1>
<p>Do this once per device. Keep the address private: <code>${url}</code></p>
${blocks}
<p><small>After setup, print a test page and tell Claude exactly where any step did not match what you see here.</small></p>`;
  }

  function mobileconfig(req) {
    const base = baseUrl(req);
    const u = new URL(base);
    const id = (s) => crypto.createHash('md5').update(s + token).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5').toUpperCase();
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>AirPrint</key><array><dict>
<key>ForceTLS</key>${u.protocol === 'https:' ? '<true/>' : '<false/>'}
<key>IPAddress</key><string>${u.hostname}</string>
<key>Port</key><integer>${u.port || (u.protocol === 'https:' ? 443 : 80)}</integer>
<key>ResourcePath</key><string>p/${token}</string>
</dict></array>
<key>PayloadType</key><string>com.apple.airprint</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>com.printio.airprint.${id('a').slice(0, 8)}</string>
<key>PayloadUUID</key><string>${id('a')}</string>
<key>PayloadDisplayName</key><string>Printio printer</string>
<key>PayloadDescription</key><string>Adds the Printio printer to this device so you can print from any app.</string>
<key>PayloadOrganization</key><string>Printio</string>
</dict></array>
<key>PayloadDisplayName</key><string>Printio printer</string>
<key>PayloadDescription</key><string>Adds the Printio printer to this device so you can print from any app.</string>
<key>PayloadOrganization</key><string>Printio</string>
<key>PayloadIdentifier</key><string>com.printio.profile.${id('b').slice(0, 8)}</string>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>${id('b')}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>
`;
  }

  const tokenOk = (t) => {
    const a = Buffer.from(t ?? '');
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };

    // SPIKE_OPEN=1: also accept IPP on ANY path (Android's add-by-address screen can't carry our
    // secret path). Test-only: anyone who finds the tunnel address could submit files. Turn it off after.
    const openIpp = openMode && req.method === 'POST' && String(req.headers['content-type']).startsWith('application/ipp');
    if (req.method === 'POST' && ((parts[0] === 'p' && tokenOk(parts[1])) || openIpp)) {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const out = handleIpp(req, Buffer.concat(chunks));
          res.writeHead(200, { 'content-type': 'application/ipp', 'content-length': out.length });
          res.end(out);
        } catch (err) {
          log({ t: new Date().toISOString(), ua: req.headers['user-agent'], error: String(err) });
          send(400, 'text/plain', 'bad IPP request');
        }
      });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'setup' && tokenOk(parts[1])) return send(200, 'text/html; charset=utf-8', setupPage(req));
    if (req.method === 'GET' && parts[0] === 'report' && tokenOk(parts[1])) return send(200, 'text/plain; charset=utf-8', report());
    if (req.method === 'GET' && parts[0] === 'p' && tokenOk(parts[1])) return send(200, 'text/html; charset=utf-8', setupPage(req));
    if (req.method === 'GET' && parts[0] === 'profile' && tokenOk(parts[1]?.replace(/\.mobileconfig$/, ''))) {
      res.writeHead(200, { 'content-type': 'application/x-apple-aspen-config', 'content-disposition': 'attachment; filename="Printio.mobileconfig"' });
      return res.end(mobileconfig(req));
    }
    return send(404, 'text/plain', 'not found');
  });

  return { server, token };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT || 8631);
  const dataDir = path.resolve(process.env.SPIKE_DATA || './spike-data');
  const formats = (process.env.SPIKE_FORMATS || 'application/pdf,image/pwg-raster,image/jpeg,application/octet-stream').split(',');
  const openMode = process.env.SPIKE_OPEN === '1';
  const { server, token } = createSpike({ dataDir, publicBase: process.env.PUBLIC_BASE, formats, openMode });
  server.listen(port, () => {
    console.log(`Printio IPP spike listening on :${port}`);
    console.log(`Data dir: ${dataDir}`);
    console.log(`Advertised formats: ${formats.join(', ')}`);
    if (openMode) console.log('SPIKE_OPEN=1: accepting IPP on ANY path (test only - stop the server when done).');
    console.log(`Local setup page : http://localhost:${port}/setup/${token}`);
    console.log(`Local report     : http://localhost:${port}/report/${token}`);
    console.log('Put the cloudflared https URL in front of this, then open <that URL>/setup/<token> on each device.');
  });
}
