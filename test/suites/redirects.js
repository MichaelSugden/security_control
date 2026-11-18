import fs from 'node:fs';
import path from 'node:path';
import { createApp, forwardedProto } from '../../src/app.js';
import { assert, serve, request, readJson, fixturePublic, PUBLIC, ROOT, HOST } from '../lib.js';

const silent = { info() {}, warn() {}, error() {} };

// Independent source: the 301 and 410 rows of the original .htaccess.
function htaccessRows() {
  const text = fs.readFileSync(path.join(ROOT, 'test/fixtures/redirects.htaccess'), 'utf8');
  const redirects = [];
  const gone = [];
  for (const line of text.split('\n')) {
    let m = line.match(/^RewriteRule \^(.*?)\/\?\$ https:\/\/securitycontrol\.nl(\/\S*) \[R=301,L\]$/);
    if (m) { redirects.push({ from: `/${m[1]}/`, to: m[2] }); continue; }
    m = line.match(/^RewriteRule \^\(nl\/\)\?(.*?)\/\?\$ - \[G,L\]$/);
    if (m) gone.push(`/${m[1]}/`, `/nl/${m[1]}/`);
  }
  return { redirects, gone };
}

// Planted defects: one row dropped, one pointing at a missing page, one chained to another old path.
function plant(data) {
  const copy = structuredClone(data);
  copy.redirects.splice(0, 1);
  copy.redirects[0].to = '/en/services/missing-page/';
  copy.redirects[1].to = copy.redirects[2].from;
  copy.gone.pop();
  delete copy.goneLang;
  return copy;
}

const expected = htaccessRows();
// Every gone path comes from the Dutch 2020 site: the NL 404 body, root-level paths included.
const GONE_LANG = 'nl';
const Q = '?utm_source=test&a=1';

export default {
  name: 'redirects',
  declared: 3 + 40 + 6 + 8,
  plantedMustFail: [
    'data: redirects.json matches the .htaccess rows',
    'data: floor of 40 redirects and 6 gone paths',
    `row ${expected.redirects[0].from}`,
    `row ${expected.redirects[1].from}`,
    `row ${expected.redirects[2].from}`,
    `gone ${expected.gone[5]}`,
    `gone ${expected.gone[0]}`,
  ],
  async build({ planted }) {
    const fileData = readJson('redirects.json');
    const data = planted ? plant(fileData) : fileData;
    const real = await serve(createApp({ publicDir: PUBLIC, redirects: data, logger: silent }));
    const fx = fixturePublic();
    const fixture = await serve(createApp({ publicDir: fx.dir, redirects: data, logger: silent }));
    const get = (p, headers) => request(real.port, { path: p, headers });
    const pageExists = (p) => fs.existsSync(path.join(PUBLIC, p, 'index.html'));
    const realNotFound = { en: path.join(PUBLIC, '404.html'), nl: path.join(PUBLIC, 'nl', '404.html') };

    const cases = [
      ['data: redirects.json matches the .htaccess rows', () => {
        const key = (r) => `${r.from} -> ${r.to}`;
        assert.deepEqual(data.redirects.map(key).sort(), expected.redirects.map(key).sort());
        assert.deepEqual([...data.gone].sort(), [...expected.gone].sort());
      }],
      ['data: floor of 40 redirects and 6 gone paths', () => {
        assert.equal(data.redirects.length, 40);
        assert.equal(data.gone.length, 6);
        assert.equal(data.goneLang, GONE_LANG, 'goneLang');
      }],
      ['data: no source is a live page and every target is a live page, not a source', () => {
        const sources = new Set(data.redirects.map((r) => r.from));
        for (const r of data.redirects) {
          assert.ok(!pageExists(r.from), `source is a live page: ${r.from}`);
          assert.ok(pageExists(r.to), `target missing: ${r.to}`);
          assert.ok(!sources.has(r.to), `chain: ${r.to}`);
        }
      }],
    ];

    for (const row of expected.redirects) {
      cases.push([`row ${row.from}`, async () => {
        const a = await get(row.from);
        assert.equal(a.status, 301, `${row.from} status`);
        assert.equal(a.headers.location, row.to);
        const b = await get(row.from.replace(/\/$/, '') + Q);
        assert.equal(b.status, 301, 'no-slash status');
        assert.equal(b.headers.location, row.to + Q);
        const c = await get(row.to);
        assert.equal(c.status, 200, `target ${row.to} answers ${c.status}`);
      }]);
    }

    for (const p of expected.gone) {
      cases.push([`gone ${p}`, async () => {
        for (const variant of [p, p.replace(/\/$/, '')]) {
          const r = await get(variant);
          assert.equal(r.status, 410, `${variant} status`);
          const file = realNotFound[GONE_LANG];
          if (fs.existsSync(file)) assert.equal(r.text, fs.readFileSync(file, 'utf8'), `${variant} body language`);
          const f = await request(fixture.port, { path: variant });
          assert.equal(f.status, 410);
          assert.equal(f.text, fx[GONE_LANG], `${variant} fixture body language`);
        }
      }]);
    }

    cases.push(
      ['root answers 301 to /nl/ with the query kept', async () => {
        const a = await get('/');
        assert.equal(a.status, 301);
        assert.equal(a.headers.location, '/nl/');
        const b = await get(`/${Q}`);
        assert.equal(b.headers.location, `/nl/${Q}`);
      }],
      ['www answers 301 to the bare host with path and query kept', async () => {
        const r = await get(`/en/faq/${Q}`, { host: `www.${HOST}` });
        assert.equal(r.status, 301);
        assert.equal(r.headers.location, `https://${HOST}/en/faq/${Q}`);
      }],
      ['http answers 301 to https when x-forwarded-proto is http', async () => {
        const r = await get('/en/', { 'x-forwarded-proto': 'http' });
        assert.equal(r.status, 301);
        assert.equal(r.headers.location, `https://${HOST}/en/`);
        const ok = await get('/en/', { 'x-forwarded-proto': 'https' });
        assert.equal(ok.status, 200);
      }],
      ['no chain: http, www and an old path without slash end in one hop', async () => {
        const r = await get(`/nl/security-services/advanced-security/fireguards${Q}`, { host: `www.${HOST}`, 'x-forwarded-proto': 'http' });
        assert.equal(r.status, 301);
        assert.equal(r.headers.location, `https://${HOST}/nl/diensten/brandwacht/${Q}`);
        const next = await get(`/nl/diensten/brandwacht/${Q}`, { 'x-forwarded-proto': 'https' });
        assert.equal(next.status, 200);
      }],
      ['a foreign host gets no host or scheme redirect, only the path fix', async () => {
        for (const host of ['www.evil.example', 'evil.example', `www.${HOST}.evil.example`, `evil.example.www.${HOST}`]) {
          const a = await get('/en/faq/', { host, 'x-forwarded-proto': 'http' });
          assert.equal(a.status, 200, `${host} status`);
          const b = await get(`/en/faq${Q}`, { host, 'x-forwarded-proto': 'http' });
          assert.equal(b.status, 301, `${host} slash fix`);
          assert.equal(b.headers.location, `/en/faq/${Q}`, `${host} location`);
        }
      }],
      ['x-forwarded-proto: the entry the one trusted hop set (the last) decides', async () => {
        const a = await get('/en/', { 'x-forwarded-proto': 'http, https' });
        assert.equal(a.status, 200, 'http, https redirected');
        const b = await get('/en/', { 'x-forwarded-proto': 'https, http' });
        assert.equal(b.status, 301);
        assert.equal(b.headers.location, `https://${HOST}/en/`);
        const c = await get('/en/faq/', { host: `www.${HOST}`, 'x-forwarded-proto': 'http, https' });
        assert.equal(c.headers.location, `https://${HOST}/en/faq/`);
      }],
      ['forwardedProto follows TRUST_PROXY: false ignores it, N hops read the Nth entry from the right', () => {
        const req = (v) => ({ get: (h) => (h.toLowerCase() === 'x-forwarded-proto' ? v : undefined) });
        assert.equal(forwardedProto(req('http, https'), 1), 'https');
        assert.equal(forwardedProto(req(' HTTP '), 1), 'http');
        assert.equal(forwardedProto(req('http, https'), false), '');
        assert.equal(forwardedProto(req('http, https'), 0), '');
        assert.equal(forwardedProto(req('http, https'), 2), 'http');
        assert.equal(forwardedProto(req('https'), 3), 'https');
        assert.equal(forwardedProto(req(undefined), 1), '');
      }],
      ['no chain: http and www on the root end in one hop at /nl/', async () => {
        const r = await get('/', { host: `www.${HOST}`, 'x-forwarded-proto': 'http' });
        assert.equal(r.status, 301);
        assert.equal(r.headers.location, `https://${HOST}/nl/`);
      }],
    );

    return { cases, close: async () => { await real.close(); await fixture.close(); } };
  },
};
