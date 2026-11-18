import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { RESULT_PAGES, SERVICES } from '../../src/contact.js';
import { assert, serve, request, readJson, fixturePublic, contentUrls, tmpDir, hasPlaceholderMarker, PLACEHOLDER_MARKER, ROOT, HOST } from '../lib.js';

const silent = { info() {}, warn() {}, error() {} };
const CONTENT_PAGES = 42;
const SOURCE_CASE = 'URL source is sitemap.xml';
const MARKER_CASE = 'no placeholder marker, so the launch cases run';
const LAUNCH_CASES = [
  'the real 404 pages exist and are served',
  'the four form result pages exist, are noindex and stay out of the sitemap',
  'contact pages post to /api/contact with the server service values',
];
const canonicalOf = (html) => (html.match(/<link[^>]+rel="canonical"[^>]*href="([^"]+)"/) || [])[1];
const robotsOf = (html) => (html.match(/<meta[^>]+name="robots"[^>]*content="([^"]+)"/) || [])[1];

// Planted defects: one page loses its canonical, one page is deleted, NL 404 carries the EN body.
function plantedPublic(urls, publicDir) {
  const dir = tmpDir('pages');
  fs.cpSync(publicDir, dir, { recursive: true });
  const first = new URL(urls[0]).pathname;
  const second = new URL(urls[1]).pathname;
  const f = path.join(dir, first, 'index.html');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/<link[^>]+rel="canonical"[^>]*>/, ''));
  fs.rmSync(path.join(dir, second, 'index.html'));
  fs.rmSync(path.join(dir, '404.html'), { force: true });
  fs.rmSync(path.join(dir, RESULT_PAGES.en.ok, 'index.html'), { force: true });
  const contact = path.join(dir, 'en/contact-us/index.html');
  fs.writeFileSync(contact, fs.readFileSync(contact, 'utf8').replace('value="specialised"', 'value="specialized"'));
  return { dir, first, second };
}

// A temp copy of the repository root holding public/ and the placeholder marker.
function markedRoot() {
  const dir = tmpDir('marker');
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, PLACEHOLDER_MARKER), '');
  return dir;
}

export default {
  name: 'pages',
  declared: 3 + CONTENT_PAGES + 4 + 3,
  get plantedMustFail() {
    const { urls } = contentUrls();
    return [`page ${new URL(urls[0]).pathname}`, `page ${new URL(urls[1]).pathname}`, 'unknown /nl/ path answers 404 with the NL page', ...LAUNCH_CASES];
  },
  // The marker planted on a temp copy must fail the marker case and send the launch cases down the skip path.
  get extraProofs() {
    return [{ label: 'pages (placeholder marker planted on a temp copy)', opts: { root: markedRoot() }, mustFail: [MARKER_CASE], mustSkip: LAUNCH_CASES }];
  },
  async build({ planted, root = ROOT }) {
    const placeholder = hasPlaceholderMarker(root);
    const { source, urls } = contentUrls(path.join(root, 'public'));
    const publicDir = planted ? plantedPublic(urls, path.join(root, 'public')).dir : path.join(root, 'public');
    const srv = await serve(createApp({ publicDir, redirects: readJson('redirects.json'), logger: silent }));
    const fx = fixturePublic({ swapLanguages: planted });
    const fixture = await serve(createApp({ publicDir: fx.dir, redirects: readJson('redirects.json'), logger: silent }));
    const get = (p, headers) => request(srv.port, { path: p, headers });

    const cases = [
      [SOURCE_CASE, () => {
        assert.equal(source, 'sitemap', 'public/sitemap.xml missing');
      }],
      [MARKER_CASE, () => {
        assert.ok(!placeholder, `${PLACEHOLDER_MARKER} exists in the repository root`);
      }],
      [`exactly ${CONTENT_PAGES} content URLs`, () => {
        assert.equal(urls.length, CONTENT_PAGES);
        assert.equal(new Set(urls).size, urls.length, 'duplicate URL');
      }],
    ];

    for (const url of urls) {
      const p = new URL(url).pathname;
      cases.push([`page ${p}`, async () => {
        assert.equal(new URL(url).host, HOST);
        const r = await get(p);
        assert.equal(r.status, 200, `${p} status`);
        assert.match(r.headers['content-type'], /text\/html/);
        assert.equal(canonicalOf(r.text), url, `${p} canonical`);
      }]);
    }

    cases.push(
      ['/en/faq answers one 301 to /en/faq/', async () => {
        const r = await get('/en/faq');
        assert.equal(r.status, 301);
        assert.equal(r.headers.location, '/en/faq/');
        assert.equal((await get('/en/faq/')).status, 200);
      }],
      ['a folder URL serves its index.html', async () => {
        const r = await get('/nl/');
        assert.equal(r.status, 200);
        assert.equal(r.text, fs.readFileSync(path.join(publicDir, 'nl/index.html'), 'utf8'));
      }],
      ['unknown path answers 404 with the EN page', async () => {
        for (const p of ['/no-such-page/', '/en/no-such-page/', '/assets/missing.css']) {
          const r = await request(fixture.port, { path: p });
          assert.equal(r.status, 404, p);
          assert.equal(r.text, fx.en, p);
        }
      }],
      ['unknown /nl/ path answers 404 with the NL page', async () => {
        const r = await request(fixture.port, { path: '/nl/bestaat-niet/' });
        assert.equal(r.status, 404);
        assert.equal(r.text, fx.nl);
      }],
      ['the real 404 pages exist and are served', async () => {
        if (placeholder) return 'skip';
        for (const [p, file] of [['/en/missing/', '404.html'], ['/nl/ontbreekt/', 'nl/404.html']]) {
          const r = await get(p);
          assert.equal(r.status, 404);
          assert.equal(r.text, fs.readFileSync(path.join(publicDir, file), 'utf8'), `${p} body`);
          assert.match(robotsOf(r.text) || '', /noindex/);
        }
        return undefined;
      }],
      ['the four form result pages exist, are noindex and stay out of the sitemap', async () => {
        if (placeholder) return 'skip';
        for (const lang of ['en', 'nl']) {
          for (const p of [RESULT_PAGES[lang].ok, RESULT_PAGES[lang].fail]) {
            const r = await get(p);
            assert.equal(r.status, 200, p);
            assert.match(robotsOf(r.text) || '', /noindex/, `${p} robots`);
            assert.ok(!urls.some((u) => new URL(u).pathname === p), `${p} is in the sitemap`);
          }
        }
        return undefined;
      }],
      ['contact pages post to /api/contact with the server service values', async () => {
        if (placeholder) return 'skip';
        for (const p of ['/en/contact-us/', '/nl/contact/']) {
          const html = (await get(p)).text;
          assert.match(html, /<form[^>]+action="\/api\/contact"[^>]*method="post"/i, `${p} form action`);
          const select = (html.match(/<select[^>]+name="service"[\s\S]*?<\/select>/) || [''])[0];
          const values = [...select.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
          assert.deepEqual(values.sort(), Object.keys(SERVICES).sort(), `${p} service values`);
        }
        return undefined;
      }],
    );

    return { cases, close: async () => { await srv.close(); await fixture.close(); } };
  },
};
