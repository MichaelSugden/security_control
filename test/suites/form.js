import addressparser from 'nodemailer/lib/addressparser';
import { createApp } from '../../src/app.js';
import { RESULT_PAGES, mailConfigFromEnv, trustProxyFromEnv } from '../../src/contact.js';
import { assert, serve, request, readJson, fixturePublic, mockTransport } from '../lib.js';

const MAIL_FROM = 'Security Control website <info@securitycontrol.nl>';
const MAIL_TO = 'info@securitycontrol.nl';
const VISITOR = {
  name: 'Jan Testpersoon',
  email: 'jan.testpersoon@example.com',
  phone: '+31 6 1234 5678',
  service: 'specialised',
  subject: 'Testonderwerp',
  message: 'Testbericht met twee regels.\r\nTweede regel.',
};

// Planted defect: any form reply becomes "unavailable", as when the mail check ran before validation.
function mailCheckFirst(app) {
  return (req, res) => {
    res.json = function json(obj) {
      const proto = Object.getPrototypeOf(this);
      if (obj && obj.code === 'invalid') return proto.json.call(this.status(503), { ok: false, code: 'unavailable' });
      return proto.json.call(this, obj);
    };
    app(req, res);
  };
}

const enc = (obj) => new URLSearchParams(obj).toString();
const headerBlock = (raw) => raw.split('\r\n\r\n')[0];

export default {
  name: 'form',
  declared: 45,
  plantedMustFail: [
    'fill time under 3 s counts as spam: ok, no mail',
    'rate limit: the 6th send from one IP in an hour is refused',
    'honeypot filled: ok, no mail',
    'elapsed decides the fill time, not the device clock',
    'rate limit: a spoofed X-Forwarded-For does not reset the limit',
    'SMTP not configured: an invalid form answers invalid with fields',
  ],
  async build({ planted }) {
    let clock = 1_800_000_000_000;
    const now = () => clock;
    const logs = [];
    const logger = { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l) };
    const fx = fixturePublic();
    const redirects = readJson('redirects.json');
    const ok = mockTransport();
    const make = (mail, extra = {}) => serve(createApp({ publicDir: fx.dir, redirects, logger, now, mail, ...extra }));
    // Planted: no minimum fill time, a rate limit that never trips, and (in post) the honeypot value moved to another field.
    // Planted also (below): trust in the leftmost X-Forwarded-For, and the old mail-check-first order.
    const plantOpts = planted
      ? { minFillMs: 0, rateLimit: { max: 1000, windowMs: 3600000 } }
      : {};
    const main = await make({ transport: ok.transport, from: MAIL_FROM, to: MAIL_TO }, plantOpts);
    // Own server for the proxy case, so its proof does not lean on the planted rate limit.
    const proxied = await make({ transport: ok.transport, from: MAIL_FROM, to: MAIL_TO }, { trustProxy: planted ? true : trustProxyFromEnv({}) });
    const failing = await make({ transport: mockTransport({ fail: true }).transport, from: MAIL_FROM, to: MAIL_TO });
    const unconfigured = planted ? await serve(mailCheckFirst(createApp({ publicDir: fx.dir, redirects, logger, now, mail: null }))) : await make(null);

    let ipSeq = 0;
    const post = (srv, fields, { json = true, ip, body, type = 'application/x-www-form-urlencoded', accept } = {}) => {
      const form = { elapsed: '10000', website: '', ...fields };
      if (planted && 'website' in fields) {
        form.website_ = form.website;
        delete form.website;
      }
      return request(srv.port, {
        method: 'POST',
        path: '/api/contact',
        headers: {
          accept: accept || (json ? 'application/json' : 'text/html,application/xhtml+xml'),
          'content-type': type,
          'x-forwarded-for': ip || `198.51.100.${(ipSeq += 1) % 250}`,
        },
        body: body ?? enc(form),
      });
    };
    const send = (fields, opts) => post(main, fields, opts);
    const count = () => ok.sent.length;

    const expectInvalid = async (fields, expected) => {
      const before = count();
      const r = await send({ lang: 'en', ...VISITOR, ...fields });
      assert.equal(r.status, 422);
      assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'invalid', fields: expected });
      assert.equal(count(), before, 'mail sent');
    };

    const cases = [
      ['valid EN, JSON reply, mail built from the fields', async () => {
        const before = count();
        const r = await send({ lang: 'en', ...VISITOR });
        assert.equal(r.status, 200);
        assert.deepEqual(JSON.parse(r.text), { ok: true });
        assert.equal(count(), before + 1);
        const { data, raw } = ok.sent.at(-1);
        assert.equal(data.from, MAIL_FROM);
        assert.equal(data.to, MAIL_TO);
        assert.deepEqual(data.replyTo, { name: VISITOR.name, address: VISITOR.email });
        assert.equal(data.subject, 'Website contact form (EN): Testonderwerp');
        for (const line of ['Name: Jan Testpersoon', 'Email: jan.testpersoon@example.com', 'Phone: +31 6 1234 5678',
          'Service: Specialised Security', 'Subject: Testonderwerp', 'Page language: EN', 'Testbericht met twee regels.\nTweede regel.']) {
          assert.ok(data.text.includes(line), `body lacks ${line}`);
        }
        assert.match(headerBlock(raw), /^Reply-To: Jan Testpersoon <jan\.testpersoon@example\.com>$/m);
      }],
      ['valid NL, JSON reply', async () => {
        const r = await send({ lang: 'nl', ...VISITOR, service: 'training' });
        assert.deepEqual(JSON.parse(r.text), { ok: true });
        assert.ok(ok.sent.at(-1).data.text.includes('Page language: NL'));
        assert.ok(ok.sent.at(-1).data.text.includes('Service: Training Services'));
      }],
      ['service other is accepted in EN and NL, mail body label Other', async () => {
        const before = count();
        for (const lang of ['en', 'nl']) {
          const r = await send({ lang, ...VISITOR, service: 'other' });
          assert.deepEqual(JSON.parse(r.text), { ok: true }, lang);
          assert.ok(ok.sent.at(-1).data.text.includes('Service: Other'), `${lang} body lacks Service: Other`);
        }
        assert.equal(count(), before + 2);
      }],
      ['valid EN, no-JS: 303 to the thank-you page', async () => {
        const before = count();
        const r = await send({ lang: 'en', ...VISITOR }, { json: false });
        assert.equal(r.status, 303);
        assert.equal(r.headers.location, RESULT_PAGES.en.ok);
        assert.equal(r.headers.location, '/en/contact-us/thank-you/');
        assert.equal(count(), before + 1);
      }],
      ['valid NL, no-JS: 303 to the bedankt page', async () => {
        const r = await send({ lang: 'nl', ...VISITOR, service: 'advanced' }, { json: false });
        assert.equal(r.status, 303);
        assert.equal(r.headers.location, '/nl/contact/bedankt/');
      }],
      ['valid with a JSON request body', async () => {
        const r = await send({}, { type: 'application/json', body: JSON.stringify({ lang: 'en', ...VISITOR, elapsed: '5000', website: '' }) });
        assert.deepEqual(JSON.parse(r.text), { ok: true });
      }],
      ['no elapsed (no-JS) is not spam: the mail is sent', async () => {
        const before = count();
        const r = await post(main, {}, { json: false, body: enc({ lang: 'nl', ...VISITOR, website: '' }) });
        assert.equal(r.headers.location, '/nl/contact/bedankt/');
        assert.equal(count(), before + 1);
      }],
      ['name missing', () => expectInvalid({ name: '   ' }, { name: 'missing' })],
      ['name too long', () => expectInvalid({ name: 'a'.repeat(201) }, { name: 'too_long' })],
      ['email missing', () => expectInvalid({ email: '' }, { email: 'missing' })],
      ['email invalid', () => expectInvalid({ email: 'jan@' }, { email: 'invalid' })],
      ['email too long', () => expectInvalid({ email: `${'a'.repeat(250)}@example.com` }, { email: 'too_long' })],
      ['phone too long', () => expectInvalid({ phone: '1'.repeat(51) }, { phone: 'too_long' })],
      ['service missing', () => expectInvalid({ service: '' }, { service: 'missing' })],
      ['service with an old translated label is refused', () => expectInvalid({ service: 'Specialised Security' }, { service: 'invalid' })],
      ['service not in the list', () => expectInvalid({ service: 'consultancy' }, { service: 'invalid' })],
      ['subject too long', () => expectInvalid({ subject: 's'.repeat(201) }, { subject: 'too_long' })],
      ['message missing', () => expectInvalid({ message: ' \r\n ' }, { message: 'missing' })],
      ['message over 5,000 characters', () => expectInvalid({ message: 'm'.repeat(5001) }, { message: 'too_long' })],
      ['message of 5,000 characters with CRLF line breaks is accepted (counted as LF)', async () => {
        const message = Array(1000).fill('abcd').join('\r\n');
        assert.ok(message.length > 5000);
        assert.equal(message.replace(/\r\n/g, '\n').length, 4999);
        const r = await send({ lang: 'en', ...VISITOR, message: `${message}x` });
        assert.deepEqual(JSON.parse(r.text), { ok: true });
      }],
      ['several failures come back together as a field map', () => expectInvalid({ email: 'nope', message: '' }, { email: 'invalid', message: 'missing' })],
      ['a field sent twice is invalid', async () => {
        const r = await post(main, {}, { body: `${enc({ lang: 'en', ...VISITOR, elapsed: '9000' })}&name=second` });
        assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'invalid', fields: { name: 'invalid' } });
      }],
      ['invalid EN, no-JS: 303 to the not-sent page', async () => {
        const r = await send({ lang: 'en', ...VISITOR, email: '' }, { json: false });
        assert.equal(r.status, 303);
        assert.equal(r.headers.location, '/en/contact-us/not-sent/');
      }],
      ['invalid NL, no-JS: 303 to the niet-verzonden page', async () => {
        const r = await send({ lang: 'nl', ...VISITOR, message: '' }, { json: false });
        assert.equal(r.status, 303);
        assert.equal(r.headers.location, '/nl/contact/niet-verzonden/');
      }],
      ['honeypot filled: ok, no mail', async () => {
        const before = count();
        const r = await send({ lang: 'en', ...VISITOR, website: 'https://spam.example' });
        assert.deepEqual(JSON.parse(r.text), { ok: true });
        const n = await send({ lang: 'nl', ...VISITOR, website: 'x' }, { json: false });
        assert.equal(n.headers.location, '/nl/contact/bedankt/');
        assert.equal(count(), before, 'mail sent for a honeypot hit');
      }],
      ['fill time under 3 s counts as spam: ok, no mail', async () => {
        const before = count();
        const r = await send({ lang: 'en', ...VISITOR, elapsed: '2999' });
        assert.deepEqual(JSON.parse(r.text), { ok: true });
        const n = await send({ lang: 'en', ...VISITOR, elapsed: '500' }, { json: false });
        assert.equal(n.headers.location, '/en/contact-us/thank-you/');
        assert.equal(count(), before, 'mail sent for a too-fast fill');
      }],
      ['fill time of exactly 3 s sends', async () => {
        const before = count();
        await send({ lang: 'en', ...VISITOR, elapsed: '3000' });
        assert.equal(count(), before + 1);
      }],
      ['elapsed decides the fill time, not the device clock', async () => {
        const before = count();
        await send({ lang: 'en', ...VISITOR, ts: String(clock + 3600000), elapsed: '20000' });
        assert.equal(count(), before + 1, 'a device clock far ahead blocked a real message');
        const r = await send({ lang: 'en', ...VISITOR, ts: String(clock - 3600000), elapsed: '800' });
        assert.deepEqual(JSON.parse(r.text), { ok: true });
        assert.equal(count(), before + 1, 'a 0.8 s fill was sent');
      }],
      ['a non-numeric or negative elapsed counts as spam', async () => {
        const before = count();
        for (const elapsed of ['abc', '-5000', '1e9', '12.5']) {
          const r = await send({ lang: 'en', ...VISITOR, elapsed });
          assert.deepEqual(JSON.parse(r.text), { ok: true }, elapsed);
        }
        assert.equal(count(), before, 'mail sent for a malformed elapsed');
      }],
      ['rate limit: the 6th send from one IP in an hour is refused', async () => {
        const ip = '203.0.113.7';
        const before = count();
        for (let i = 0; i < 5; i += 1) {
          const r = await send({ lang: 'en', ...VISITOR }, { ip });
          assert.equal(r.status, 200, `send ${i + 1}`);
        }
        const sixth = await send({ lang: 'en', ...VISITOR }, { ip });
        assert.equal(sixth.status, 429);
        assert.deepEqual(JSON.parse(sixth.text), { ok: false, code: 'rate_limited' });
        assert.ok(Number(sixth.headers['retry-after']) > 0);
        const noJs = await send({ lang: 'nl', ...VISITOR }, { ip, json: false });
        assert.equal(noJs.headers.location, '/nl/contact/niet-verzonden/');
        assert.equal(count(), before + 5);
        assert.equal((await send({ lang: 'en', ...VISITOR }, { ip: '203.0.113.8' })).status, 200, 'other IP blocked');
        clock += 3600 * 1000;
        assert.equal((await send({ lang: 'en', ...VISITOR }, { ip })).status, 200, 'still blocked after an hour');
      }],
      ['rate limit: a spoofed X-Forwarded-For does not reset the limit', async () => {
        const proxyAdded = '203.0.113.30';
        const before = count();
        for (let i = 0; i < 5; i += 1) {
          const r = await post(proxied, { lang: 'en', ...VISITOR }, { ip: `10.9.8.${i}, ${proxyAdded}` });
          assert.equal(r.status, 200, `send ${i + 1}`);
        }
        const sixth = await post(proxied, { lang: 'en', ...VISITOR }, { ip: `192.0.2.99, ${proxyAdded}` });
        assert.equal(sixth.status, 429, 'a new leftmost address reset the limit');
        assert.equal(count(), before + 5);
      }],
      ['TRUST_PROXY: default 1 hop, a number of hops, or false', () => {
        assert.equal(trustProxyFromEnv({}), 1);
        assert.equal(trustProxyFromEnv({ TRUST_PROXY: '' }), 1);
        assert.equal(trustProxyFromEnv({ TRUST_PROXY: '2' }), 2);
        assert.equal(trustProxyFromEnv({ TRUST_PROXY: 'false' }), false);
        assert.equal(trustProxyFromEnv({ TRUST_PROXY: 'true' }), 1);
      }],
      ['invalid and spam submissions do not use up the rate limit', async () => {
        const ip = '203.0.113.9';
        for (let i = 0; i < 6; i += 1) await send({ lang: 'en', ...VISITOR, email: '' }, { ip });
        for (let i = 0; i < 6; i += 1) await send({ lang: 'en', ...VISITOR, website: 'x' }, { ip });
        assert.equal((await send({ lang: 'en', ...VISITOR }, { ip })).status, 200);
      }],
      ['SMTP failure: code error, and the not-sent page without JS', async () => {
        const r = await post(failing, { lang: 'en', ...VISITOR });
        assert.equal(r.status, 502);
        assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'error' });
        const n = await post(failing, { lang: 'nl', ...VISITOR }, { json: false });
        assert.equal(n.headers.location, '/nl/contact/niet-verzonden/');
      }],
      ['SMTP not configured: an invalid form answers invalid with fields', async () => {
        const r = await post(unconfigured, { lang: 'en', ...VISITOR, email: 'jan@', message: '' });
        assert.equal(r.status, 422);
        assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'invalid', fields: { email: 'invalid', message: 'missing' } });
        const n = await post(unconfigured, { lang: 'nl', ...VISITOR, name: '' }, { json: false });
        assert.equal(n.headers.location, '/nl/contact/niet-verzonden/');
      }],
      ['SMTP not configured: a valid form answers unavailable, and the server still serves', async () => {
        const r = await post(unconfigured, { lang: 'en', ...VISITOR });
        assert.equal(r.status, 503);
        assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'unavailable' });
        const n = await post(unconfigured, { lang: 'en', ...VISITOR }, { json: false });
        assert.equal(n.headers.location, '/en/contact-us/not-sent/');
        assert.equal((await request(unconfigured.port, { path: '/healthz' })).status, 200);
      }],
      ['header injection: a line break in name, email, subject or phone is refused', async () => {
        await expectInvalid({ name: 'Jan\r\nBcc: victim@example.org' }, { name: 'invalid' });
        await expectInvalid({ email: 'jan@example.com\r\nBcc: victim@example.org' }, { email: 'invalid' });
        await expectInvalid({ subject: 'Hi\nBcc: victim@example.org' }, { subject: 'invalid' });
        await expectInvalid({ phone: '06\r\nCc: victim@example.org' }, { phone: 'invalid' });
      }],
      ['header injection: quotes and angle brackets stay inside one encoded Reply-To', async () => {
        const name = 'Jan "x" <victim@example.org>, Bcc: victim@example.org';
        const r = await send({ lang: 'en', ...VISITOR, name, subject: 'To: victim@example.org' });
        assert.deepEqual(JSON.parse(r.text), { ok: true });
        const head = headerBlock(ok.sent.at(-1).raw);
        assert.ok(!/^(Bcc|Cc):/im.test(head), 'Bcc or Cc header present');
        assert.equal((head.match(/^To:/gm) || []).length, 1);
        assert.match(head, /^To: info@securitycontrol\.nl$/m);
        const replyTo = head.match(/^Reply-To:(.*(?:\r\n[ \t].*)*)/m)[1].replace(/\r\n[ \t]/g, ' ');
        const parsed = addressparser(replyTo);
        assert.equal(parsed.length, 1, `Reply-To parses to ${parsed.length} addresses`);
        assert.equal(parsed[0].address, VISITOR.email);
        assert.equal(parsed[0].name, name);
      }],
      ['unknown lang falls back to EN', async () => {
        const r = await send({ lang: 'fr', ...VISITOR, email: '' }, { json: false });
        assert.equal(r.headers.location, '/en/contact-us/not-sent/');
      }],
      ['a multipart body is refused with code error', async () => {
        const r = await post(main, {}, { type: 'multipart/form-data; boundary=x', body: '--x--' });
        assert.equal(r.status, 502);
        assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'error' });
      }],
      ['a malformed JSON body is refused with code error', async () => {
        const r = await post(main, {}, { type: 'application/json', body: '{"name":' });
        assert.deepEqual(JSON.parse(r.text), { ok: false, code: 'error' });
      }],
      ['an oversized body is refused, NL page for an NL referer', async () => {
        const r = await request(main.port, {
          method: 'POST', path: '/api/contact',
          headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://securitycontrol.nl/nl/contact/' },
          body: enc({ lang: 'nl', ...VISITOR, message: 'm'.repeat(40000) }),
        });
        assert.equal(r.status, 303);
        assert.equal(r.headers.location, '/nl/contact/niet-verzonden/');
      }],
      ['GET on the endpoint answers 405', async () => {
        const r = await request(main.port, { path: '/api/contact' });
        assert.equal(r.status, 405);
        assert.equal(r.headers.allow, 'POST');
      }],
      ['SMTP env: names required, MAIL_TO default, SMTP_SECURE default from the port', () => {
        assert.deepEqual(mailConfigFromEnv({}).missing, ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']);
        const env = { SMTP_HOST: 'smtp.example.org', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'info@securitycontrol.nl' };
        const a = mailConfigFromEnv(env).config;
        assert.equal(a.to, 'info@securitycontrol.nl');
        assert.equal(a.transport.secure, true);
        const b = mailConfigFromEnv({ ...env, SMTP_PORT: '587', MAIL_TO: 'other@example.org' }).config;
        assert.equal(b.transport.secure, false);
        assert.equal(b.transport.requireTLS, true);
        assert.equal(b.to, 'other@example.org');
        assert.equal(mailConfigFromEnv({ ...env, SMTP_PORT: 'abc' }).config, null);
      }],
      ['logs carry outcome codes only, never personal data', () => {
        assert.ok(logs.length > 20, 'too few log lines to judge');
        const personal = [VISITOR.name, 'Testpersoon', VISITOR.email, '1234 5678', 'Testonderwerp', 'Testbericht', '198.51.100', '203.0.113', 'victim'];
        for (const line of logs) {
          for (const p of personal) assert.ok(!line.includes(p), `log line carries personal data: ${line}`);
          assert.match(line, /^contact (ok|invalid|rate_limited|unavailable|error) (json|form) (en|nl)( [\w=-]+)?$/, `log format: ${line}`);
        }
      }],
    ];

    return { cases, close: async () => { await proxied.close(); await main.close(); await failing.close(); await unconfigured.close(); } };
  },
};
