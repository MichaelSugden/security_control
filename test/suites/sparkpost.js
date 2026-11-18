import addressparser from 'nodemailer/lib/addressparser';
import { createApp } from '../../src/app.js';
import { buildMail, mailRouteFromEnv } from '../../src/contact.js';
import { assert, serve, request, readJson, fixturePublic, mockTransport } from '../lib.js';

const KEY = 'test-key';
const MAIL_FROM = 'Security Control website <info@securitycontrol.nl>';
const MAIL_TO = 'bkiepe@securitycontrol.nl';
const BODY_MARKER = 'sparkpost-response-body-marker';
const VISITOR = {
  name: 'Jan Testpersoon',
  email: 'jan.testpersoon@example.com',
  phone: '+31 6 1234 5678',
  service: 'other',
  subject: 'Testonderwerp',
  message: 'Testbericht met twee regels.\r\nTweede regel.',
};
const HOSTILE = 'Jan "x" <victim@example.org>, Bcc: victim@example.org \\';
const NON_ASCII = 'Jürgen Ødegård-Ünal, beveiliging en training voor evenementen in Zuid-Nederland';
const enc = (obj) => new URLSearchParams(obj).toString();
const decodeWords = (s) => s.replace(/=\?UTF-8\?B\?([^?]*)\?=(\s+(?==\?))?/g, (m, b) => Buffer.from(b, 'base64').toString('utf8'));

// Mock fetch: records each call and answers from the handler queue (default 200).
function mockFetch() {
  const calls = [];
  const queue = [];
  const fn = async (url, init) => {
    calls.push({ url, init, headers: init.headers, body: JSON.parse(init.body) });
    const next = queue.shift();
    if (next) return next(init);
    return new Response(JSON.stringify({ results: { id: '1', total_accepted_recipients: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn, calls, then: (h) => queue.push(h) };
}
const answer = (status) => () => new Response(JSON.stringify({ errors: [{ message: `refused ${BODY_MARKER} ${KEY}` }] }), { status });
const hang = (init) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(new Response('{}', { status: 200 })), 20000);
  t.unref();
  if (init.signal) init.signal.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); });
});

// Planted defects between the app and SparkPost: US host for EU, no key, tracking on, raw Reply-To, refusals read as 200, no time limit.
const planted = (fn) => async (url, init) => {
  const body = JSON.parse(init.body);
  body.options.open_tracking = true;
  body.content.reply_to = body.content.reply_to.replace(/^"((?:[^"\\]|\\.)*)"/, (m, n) => n.replace(/\\(.)/g, '$1'));
  const headers = { ...init.headers };
  delete headers.Authorization;
  const res = await fn(url.replace('api.eu.sparkpost.com', 'api.sparkpost.com'), { ...init, headers, body: JSON.stringify(body), signal: undefined });
  return res.status >= 400 ? new Response('{}', { status: 200 }) : res;
};

export default {
  name: 'sparkpost',
  declared: 15,
  plantedMustFail: [
    'request URL per region: eu to the EU host, anything else to the US host',
    'POST with the key in Authorization and a JSON body',
    'Reply-To is the visitor: one address with quotes, angle brackets, commas and a backslash in the name',
    'options: transactional, open and click tracking off',
    'a 4xx reply answers error: 502 JSON and the not-sent page',
    'a 5xx reply answers error',
    'a request over the time limit answers error within the limit',
  ],
  async build({ planted: plant }) {
    const logs = [];
    const logger = { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l) };
    const fx = fixturePublic();
    const redirects = readJson('redirects.json');
    const env = { SPARKPOST_API_KEY: KEY, MAIL_FROM, MAIL_TO };
    const servers = [];
    // One app per region or limit, each on a mock fetch of its own.
    const make = async (extraEnv = {}, { timeoutMs } = {}) => {
      const mock = mockFetch();
      const { config } = mailRouteFromEnv({ ...env, ...extraEnv });
      config.sparkpost.fetch = plant ? planted(mock.fn) : mock.fn;
      if (timeoutMs) config.sparkpost.timeoutMs = timeoutMs;
      const srv = await serve(createApp({ publicDir: fx.dir, redirects, logger, mail: config }));
      servers.push(srv);
      return { srv, mock, config };
    };
    const eu = await make({ SPARKPOST_REGION: 'eu' });
    const us = await make({ SPARKPOST_REGION: '' });
    const other = await make({ SPARKPOST_REGION: 'us-west' });
    const quick = await make({ SPARKPOST_REGION: 'EU ' }, { timeoutMs: 300 });

    let ipSeq = 0;
    const post = (srv, fields, { json = true } = {}) => request(srv.port, {
      method: 'POST',
      path: '/api/contact',
      headers: {
        accept: json ? 'application/json' : 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': `198.51.100.${(ipSeq += 1) % 250}`,
      },
      body: enc({ elapsed: '10000', website: '', lang: 'en', ...VISITOR, ...fields }),
    });

    const cases = [
      ['request URL per region: eu to the EU host, anything else to the US host', async () => {
        for (const [app, host] of [[eu, 'api.eu.sparkpost.com'], [quick, 'api.eu.sparkpost.com'], [us, 'api.sparkpost.com'], [other, 'api.sparkpost.com']]) {
          await post(app.srv, {});
          assert.equal(app.mock.calls.at(-1).url, `https://${host}/api/v1/transmissions`);
        }
      }],
      ['POST with the key in Authorization and a JSON body', async () => {
        const r = await post(eu.srv, {});
        assert.deepEqual(JSON.parse(r.text), { ok: true });
        const { init, headers } = eu.mock.calls.at(-1);
        assert.equal(init.method, 'POST');
        assert.equal(headers.Authorization, KEY);
        assert.equal(headers['Content-Type'], 'application/json');
      }],
      ['transmission: MAIL_FROM, recipient MAIL_TO, subject and text as the SMTP mail', async () => {
        await post(eu.srv, { lang: 'nl' });
        const { body } = eu.mock.calls.at(-1);
        const smtp = buildMail({ ...VISITOR, message: VISITOR.message.replace(/\r\n/g, '\n') }, 'nl', { from: MAIL_FROM, to: MAIL_TO });
        assert.deepEqual(body.content.from, { name: 'Security Control website', email: 'info@securitycontrol.nl' });
        assert.deepEqual(body.recipients, [{ address: { email: MAIL_TO } }]);
        assert.equal(body.content.subject, smtp.subject);
        assert.equal(body.content.text, smtp.text);
        assert.ok(body.content.text.includes('Service: Other'));
        assert.ok(body.content.text.includes('Testbericht met twee regels.\nTweede regel.'));
      }],
      ['Reply-To is the visitor: one address with quotes, angle brackets, commas and a backslash in the name', async () => {
        for (const name of [VISITOR.name, HOSTILE]) {
          const r = await post(eu.srv, { name });
          assert.deepEqual(JSON.parse(r.text), { ok: true });
          const parsed = addressparser(eu.mock.calls.at(-1).body.content.reply_to);
          assert.equal(parsed.length, 1, `${name}: Reply-To parses to ${parsed.length} addresses`);
          assert.equal(parsed[0].address, VISITOR.email);
          assert.equal(parsed[0].name, name);
        }
      }],
      ['Reply-To with a long non-ASCII name: encoded words of at most 75 characters that decode to the name', async () => {
        await post(eu.srv, { name: NON_ASCII });
        const replyTo = eu.mock.calls.at(-1).body.content.reply_to;
        assert.ok(/^[\x20-\x7e]+$/.test(replyTo), 'Reply-To is not plain ASCII');
        for (const w of replyTo.match(/=\?[^ ]+\?=/g)) assert.ok(w.length <= 75, `encoded word of ${w.length}`);
        const parsed = addressparser(replyTo);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].address, VISITOR.email);
        assert.equal(decodeWords(replyTo).replace(/ <[^>]+>$/, ''), NON_ASCII);
      }],
      ['options: transactional, open and click tracking off', async () => {
        await post(us.srv, {});
        assert.deepEqual(us.mock.calls.at(-1).body.options, { transactional: true, open_tracking: false, click_tracking: false });
      }],
      ['a 2xx reply answers ok, and the thank-you page without JS', async () => {
        eu.mock.then(() => new Response('{}', { status: 202 }));
        const r = await post(eu.srv, {});
        assert.equal(r.status, 200);
        assert.deepEqual(JSON.parse(r.text), { ok: true });
        const n = await post(eu.srv, { lang: 'nl' }, { json: false });
        assert.equal(n.status, 303);
        assert.equal(n.headers.location, '/nl/contact/bedankt/');
      }],
      ['a 4xx reply answers error: 502 JSON and the not-sent page', async () => {
        for (const status of [400, 401, 403, 422]) {
          eu.mock.then(answer(status));
          const r = await post(eu.srv, {});
          assert.equal(r.status, 502, `${status}`);
          assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'error' });
        }
        eu.mock.then(answer(401));
        const n = await post(eu.srv, {}, { json: false });
        assert.equal(n.headers.location, '/en/contact-us/not-sent/');
      }],
      ['a 5xx reply answers error', async () => {
        for (const status of [500, 503]) {
          us.mock.then(answer(status));
          const r = await post(us.srv, {});
          assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'error' }, `${status}`);
        }
      }],
      ['a request over the time limit answers error within the limit', async () => {
        quick.mock.then(hang);
        const started = Date.now();
        const r = await Promise.race([
          post(quick.srv, {}),
          new Promise((_, reject) => { setTimeout(() => reject(new Error('no reply within 3 s')), 3000).unref(); }),
        ]);
        assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'error' });
        assert.ok(Date.now() - started >= 250, 'answered before the limit');
        assert.ok(quick.mock.calls.at(-1).init.signal, 'no abort signal on the request');
      }],
      ['a network error answers error', async () => {
        other.mock.then(() => { throw new TypeError('fetch failed'); });
        const r = await post(other.srv, {});
        assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'error' });
      }],
      ['spam and invalid submissions make no SparkPost request', async () => {
        const before = eu.mock.calls.length;
        await post(eu.srv, { website: 'x' });
        await post(eu.srv, { elapsed: '500' });
        const r = await post(eu.srv, { email: 'jan@' });
        assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'invalid', fields: { email: 'invalid' } });
        assert.equal(eu.mock.calls.length, before);
      }],
      ['route: a key selects SparkPost and needs MAIL_FROM; no key selects SMTP; neither is unavailable', () => {
        const sp = mailRouteFromEnv(env);
        assert.equal(sp.route, 'sparkpost');
        assert.equal(sp.config.to, MAIL_TO);
        assert.equal(sp.config.sparkpost.timeoutMs, 10000);
        assert.deepEqual(mailRouteFromEnv({ SPARKPOST_API_KEY: KEY }), { route: 'sparkpost', config: null, missing: ['MAIL_FROM'] });
        assert.equal(mailRouteFromEnv({ SPARKPOST_API_KEY: KEY, MAIL_FROM }).config.to, 'info@securitycontrol.nl');
        const smtpEnv = { SMTP_HOST: 'smtp.example.org', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM };
        for (const extra of [{}, { SPARKPOST_API_KEY: '' }, { SPARKPOST_API_KEY: '   ' }, { SPARKPOST_REGION: 'eu' }]) {
          const r = mailRouteFromEnv({ ...smtpEnv, ...extra });
          assert.equal(r.route, 'smtp', JSON.stringify(extra));
          assert.equal(r.config.transport.host, 'smtp.example.org');
          assert.equal(r.config.sparkpost, undefined);
        }
        const none = mailRouteFromEnv({});
        assert.equal(none.config, null);
        assert.equal(none.route, 'smtp');
      }],
      ['no key: the SMTP route sends and fetch is never called', async () => {
        const realFetch = globalThis.fetch;
        let fetched = 0;
        globalThis.fetch = async () => { fetched += 1; return new Response('{}', { status: 200 }); };
        const smtp = mockTransport();
        const { config } = mailRouteFromEnv({ SMTP_HOST: 'smtp.example.org', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM, MAIL_TO });
        const srv = await serve(createApp({ publicDir: fx.dir, redirects, logger, mail: { ...config, transport: smtp.transport } }));
        try {
          const r = await post(srv, {});
          assert.deepEqual(JSON.parse(r.text), { ok: true });
          assert.equal(smtp.sent.length, 1);
          assert.equal(smtp.sent[0].data.to, MAIL_TO);
          assert.equal(fetched, 0, 'fetch was called on the SMTP route');
        } finally {
          globalThis.fetch = realFetch;
          await srv.close();
        }
      }],
      ['logs: outcome and HTTP status only; never the key, visitor data or the response body', () => {
        const leaks = (lines) => {
          const bad = [KEY, BODY_MARKER, 'refused', VISITOR.name, 'Testpersoon', VISITOR.email, '1234 5678', 'Testonderwerp', 'Testbericht', 'victim', 'Jürgen', '198.51.100'];
          return lines.filter((l) => bad.some((b) => l.includes(b))
            || !/^contact (ok|invalid|rate_limited|unavailable|error) (json|form) (en|nl)( (sparkpost=(\d{3}|timeout|network)|spam))?$/.test(l));
        };
        assert.equal(leaks([`contact error json en sparkpost=401 ${KEY}`, 'contact ok json en smtp=x y']).length, 2, 'leak check does not bite');
        assert.ok(logs.filter((l) => /sparkpost=(4|5)\d\d$/.test(l)).length >= 7, 'too few refusal log lines to judge');
        assert.ok(logs.some((l) => l.endsWith('sparkpost=timeout')) && logs.some((l) => l.endsWith('sparkpost=network')), 'timeout or network line missing');
        assert.ok(logs.some((l) => l === 'contact ok json en sparkpost=200'), 'ok line with status missing');
        assert.deepEqual(leaks(logs), []);
      }],
    ];

    return { cases, close: async () => { for (const s of servers) await s.close(); } };
  },
};
