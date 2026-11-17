import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../src/app.js';
import { assert, serve, request, readJson, PUBLIC } from '../lib.js';

const silent = { info() {}, warn() {}, error() {} };
const hash = (s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;

// Independent scan of public/: executable inline scripts, style blocks, style attributes.
function scanInline() {
  const scripts = new Set();
  const styles = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.html')) continue;
      const html = fs.readFileSync(full, 'utf8');
      const parts = html.split(/<script/i).slice(1);
      for (const part of parts) {
        const close = part.indexOf('>');
        const attrs = part.slice(0, close);
        if (/\bsrc=/i.test(attrs) || /type=["']?application\/(ld\+)?json/i.test(attrs)) continue;
        scripts.add(hash(part.slice(close + 1, part.search(/<\/script/i))));
      }
      for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) styles.add(hash(m[1]));
      for (const m of html.matchAll(/ style="([^"]*)"/g)) styles.add(hash(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')));
    }
  };
  walk(PUBLIC);
  return { scripts, styles };
}

const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

function checkSecurityHeaders(h) {
  assert.ok(h['content-security-policy'], 'CSP missing');
  assert.equal(h['strict-transport-security'], 'max-age=31536000');
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.match(h['permissions-policy'] || '', /camera=\(\)/);
}

// Planted defects: HSTS and X-Robots-Tag dropped, unsafe-inline added to scripts, HTML made cacheable.
function tamper(app) {
  return (req, res) => {
    const orig = res.setHeader.bind(res);
    res.setHeader = (k, v) => {
      const key = k.toLowerCase();
      if (key === 'strict-transport-security' || key === 'x-robots-tag') return res;
      if (key === 'content-security-policy') v = String(v).replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
      if (key === 'cache-control' && v === 'no-cache') v = 'max-age=600';
      return orig(k, v);
    };
    app(req, res);
  };
}

export default {
  name: 'headers',
  declared: 15,
  plantedMustFail: [
    'page CSP is self only with no unsafe-inline for scripts',
    'page has HSTS, nosniff, Referrer-Policy and Permissions-Policy',
    'X-Robots-Tag noindex on a host other than securitycontrol.nl',
    'HTML is sent no-cache with an ETag',
  ],
  async build({ planted }) {
    const app = createApp({ publicDir: PUBLIC, redirects: readJson('redirects.json'), logger: silent });
    const srv = await serve(planted ? tamper(app) : app);
    const get = (p, headers) => request(srv.port, { path: p, headers });
    const inline = scanInline();

    const cases = [
      ['page CSP is self only with no unsafe-inline for scripts', async () => {
        const csp = (await get('/en/')).headers['content-security-policy'];
        const d = directives(csp);
        assert.deepEqual(d['default-src'], ["'self'"]);
        assert.deepEqual(d['frame-ancestors'], ["'none'"]);
        assert.deepEqual(d['object-src'], ["'none'"]);
        assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), 'unsafe-inline or unsafe-eval present');
        assert.ok(!d['script-src'].includes("'unsafe-hashes'"), 'unsafe-hashes on scripts');
        assert.ok(!/https?:|\*|data:/.test(csp), 'host, wildcard or data: source present');
      }],
      ['CSP hashes cover every inline script in public/', async () => {
        const d = directives((await get('/en/')).headers['content-security-policy']);
        assert.ok(inline.scripts.size > 0, 'scan found no inline script');
        for (const h of inline.scripts) assert.ok(d['script-src'].includes(h), `script hash missing ${h}`);
      }],
      ['CSP hashes cover every style block and style attribute in public/', async () => {
        const d = directives((await get('/en/')).headers['content-security-policy']);
        assert.ok(inline.styles.size > 0, 'scan found no inline style');
        for (const h of inline.styles) assert.ok(d['style-src'].includes(h), `style hash missing ${h}`);
      }],
      ['page has HSTS, nosniff, Referrer-Policy and Permissions-Policy', async () => {
        checkSecurityHeaders((await get('/en/')).headers);
      }],
      ['no X-Powered-By header', async () => {
        assert.equal((await get('/en/')).headers['x-powered-by'], undefined);
      }],
      ['X-Robots-Tag noindex on a host other than securitycontrol.nl', async () => {
        const r = await get('/en/', { host: 'securitycontrol-v2.replit.app' });
        assert.equal(r.status, 200);
        assert.equal(r.headers['x-robots-tag'], 'noindex');
      }],
      ['no X-Robots-Tag on securitycontrol.nl', async () => {
        assert.equal((await get('/en/')).headers['x-robots-tag'], undefined);
      }],
      ['security headers on a 404', async () => {
        const r = await get('/en/no-such-page/');
        assert.equal(r.status, 404);
        checkSecurityHeaders(r.headers);
      }],
      ['security headers on a 301', async () => {
        const r = await get('/en/security-services/');
        assert.equal(r.status, 301);
        checkSecurityHeaders(r.headers);
      }],
      ['security headers on the form endpoint reply', async () => {
        const r = await request(srv.port, { method: 'POST', path: '/api/contact', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: 'lang=en' });
        assert.equal(r.headers['cache-control'], 'no-store');
        checkSecurityHeaders(r.headers);
      }],
      ['HTML is sent no-cache with an ETag', async () => {
        const r = await get('/nl/');
        assert.equal(r.headers['cache-control'], 'no-cache');
        assert.ok(r.headers.etag, 'ETag missing');
        assert.match(r.headers['content-type'], /text\/html/);
      }],
      ['assets get a long max-age and an ETag, and revalidate with 304', async () => {
        const r = await get('/assets/css/site.css');
        assert.equal(r.status, 200);
        assert.equal(r.headers['cache-control'], 'public, max-age=31536000');
        assert.ok(r.headers.etag, 'ETag missing');
        const again = await get('/assets/css/site.css', { 'if-none-match': r.headers.etag });
        assert.equal(again.status, 304);
      }],
      ['HTML is compressed when the client accepts gzip', async () => {
        const plain = await get('/en/');
        const gz = await get('/en/', { 'accept-encoding': 'gzip' });
        assert.equal(gz.headers['content-encoding'], 'gzip');
        assert.ok(gz.raw.length < plain.raw.length, 'not smaller');
        assert.equal(gz.text, plain.text);
      }],
      ['CSS is compressed when the client accepts gzip', async () => {
        const gz = await get('/assets/css/site.css', { 'accept-encoding': 'gzip' });
        assert.equal(gz.headers['content-encoding'], 'gzip');
        assert.equal(gz.text, fs.readFileSync(path.join(PUBLIC, 'assets/css/site.css'), 'utf8'));
      }],
      ['GET /healthz answers 200', async () => {
        const r = await get('/healthz');
        assert.equal(r.status, 200);
        assert.equal(r.text, 'ok');
      }],
    ];
    return { cases, close: srv.close };
  },
};
