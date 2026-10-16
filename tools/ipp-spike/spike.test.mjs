import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attr, decodeIpp, encodeIpp, flatten, OP, STATUS, TAG } from './ipp.mjs';
import { createSpike } from './server.mjs';

const opHead = [attr(TAG.charset, 'attributes-charset', 'utf-8'), attr(TAG.language, 'attributes-natural-language', 'en')];

test('codec round-trips scalars, multi-values and nested collections', () => {
  const buf = encodeIpp({
    code: 0x000b,
    requestId: 7,
    groups: [
      { tag: TAG.operation, attrs: [...opHead, attr(TAG.keyword, 'requested-attributes', 'a', 'b')] },
      { tag: TAG.printer, attrs: [
        attr(TAG.integer, 'n', 5),
        attr(TAG.boolean, 'ok', true),
        attr(TAG.range, 'r', [1, 9]),
        attr(TAG.resolution, 'res', { x: 600, y: 600, units: 3 }),
        attr(TAG.begCollection, 'col', [{ name: 'size', tag: TAG.begCollection, values: [[
          { name: 'x', tag: TAG.integer, values: [21000] },
        ]] }]),
      ] },
    ],
  });
  const m = decodeIpp(buf);
  assert.equal(m.requestId, 7);
  assert.deepEqual(flatten(m.groups[0])['requested-attributes'], ['a', 'b']);
  const p = flatten(m.groups[1]);
  assert.equal(p.n, 5);
  assert.equal(p.ok, true);
  assert.deepEqual(p.r, [1, 9]);
  assert.deepEqual(p.res, { x: 600, y: 600, units: 3 });
  assert.deepEqual(p.col, { size: { x: 21000 } });
});

async function withSpike(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipp-spike-'));
  const { server, token } = createSpike({ dataDir, publicBase: null, formats: ['application/pdf', 'image/pwg-raster'] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, token, dataDir });
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const post = async (url, msg, doc = Buffer.alloc(0)) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/ipp', 'user-agent': 'test-client' },
    body: Buffer.concat([encodeIpp(msg), doc]),
  });
  return { res, ipp: decodeIpp(Buffer.from(await res.arrayBuffer())) };
};

test('Get-Printer-Attributes advertises PDF and monochrome', async () => {
  await withSpike(async ({ base, token }) => {
    const { res, ipp } = await post(`${base}/p/${token}`, {
      code: OP.getPrinterAttributes, requestId: 1,
      groups: [{ tag: TAG.operation, attrs: [...opHead, attr(TAG.uri, 'printer-uri', `${base}/p/${token}`)] }],
    });
    assert.equal(res.status, 200);
    assert.equal(ipp.code, STATUS.ok);
    const p = flatten(ipp.groups.find((g) => g.tag === TAG.printer));
    assert.deepEqual(p['document-format-supported'], ['application/pdf', 'image/pwg-raster']);
    assert.equal(p['print-color-mode-supported'], 'monochrome');
    assert.deepEqual(p['media-col-default'], { 'media-size': { 'x-dimension': 21000, 'y-dimension': 29700 } });
  });
});

test('Print-Job saves the document, records options, and reports completed', async () => {
  await withSpike(async ({ base, token, dataDir }) => {
    const pdf = Buffer.from('%PDF-1.4\nfake');
    const { ipp } = await post(`${base}/p/${token}`, {
      code: OP.printJob, requestId: 2,
      groups: [
        { tag: TAG.operation, attrs: [...opHead,
          attr(TAG.uri, 'printer-uri', `${base}/p/${token}`),
          attr(TAG.name, 'job-name', 'Homework.pdf'),
          attr(TAG.mime, 'document-format', 'application/pdf')] },
        { tag: TAG.job, attrs: [attr(TAG.integer, 'copies', 2), attr(TAG.keyword, 'sides', 'two-sided-long-edge')] },
      ],
    }, pdf);
    assert.equal(ipp.code, STATUS.ok);
    assert.equal(flatten(ipp.groups.find((g) => g.tag === TAG.job))['job-state'], 9);
    const saved = fs.readdirSync(path.join(dataDir, 'jobs'));
    assert.equal(saved.length, 1);
    assert.match(saved[0], /Homework.*\.pdf$/);
    const logged = fs.readFileSync(path.join(dataDir, 'requests.jsonl'), 'utf8');
    assert.match(logged, /two-sided-long-edge/);
    assert.ok(!logged.includes(token), 'token must be redacted from logs');
    const rep = await (await fetch(`${base}/report/${token}`)).text();
    assert.match(rep, /actual=pdf/);
  });
});

test('wrong token is a 404, setup page and profile work with the token', async () => {
  await withSpike(async ({ base, token }) => {
    assert.equal((await fetch(`${base}/p/nope`, { method: 'POST', body: 'x' })).status, 404);
    assert.equal((await fetch(`${base}/setup/${token}`)).status, 200);
    const prof = await fetch(`${base}/profile/${token}.mobileconfig`);
    assert.equal(prof.headers.get('content-type'), 'application/x-apple-aspen-config');
    assert.match(await prof.text(), /com\.apple\.airprint/);
  });
});

test('open mode accepts IPP on a bare path; closed mode does not', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipp-spike-'));
  for (const openMode of [true, false]) {
    const { server } = createSpike({ dataDir, publicBase: null, formats: ['application/pdf'], openMode });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/ipp/print`, {
        method: 'POST',
        headers: { 'content-type': 'application/ipp' },
        body: encodeIpp({ code: OP.getPrinterAttributes, requestId: 1, groups: [{ tag: TAG.operation, attrs: opHead }] }),
      });
      assert.equal(res.status, openMode ? 200 : 404);
    } finally {
      server.close();
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
