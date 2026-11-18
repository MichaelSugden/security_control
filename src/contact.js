import express from 'express';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';

// Stable service values sent by the form in both languages; the labels are for the mail body.
export const SERVICES = {
  specialised: 'Specialised Security',
  advanced: 'Advanced Security',
  training: 'Training Services',
  other: 'Other',
};

export const LIMITS = { name: 200, email: 254, phone: 50, subject: 200, message: 5000 };

export const RESULT_PAGES = {
  en: { ok: '/en/contact-us/thank-you/', fail: '/en/contact-us/not-sent/' },
  nl: { ok: '/nl/contact/bedankt/', fail: '/nl/contact/niet-verzonden/' },
};

const STATUS = { invalid: 422, rate_limited: 429, unavailable: 503, error: 502 };

// The browser's own rule for type="email" (WHATWG), so the server accepts what the page accepts.
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const SINGLE_LINE_BAD = /[\u0000-\u001f\u007f]/;
const MULTI_LINE_BAD = /[\u0000-\u0008\u000b-\u001f\u007f]/;

const count = (s) => Array.from(s).length;

// Language for replies sent before the body is read: taken from the page that posted.
const langFromReferer = (req) => (/^https?:\/\/[^/]+\/nl\//.test(req.get('referer') || '') ? 'nl' : 'en');

// Returns { values, fields } where fields maps each failed field to missing, invalid or too_long.
export function validate(body) {
  const fields = {};
  const values = {};
  const read = (key) => {
    const v = body[key];
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') return null;
    return v;
  };
  for (const key of ['name', 'email', 'phone', 'service', 'subject']) {
    const raw = read(key);
    if (raw === null) { fields[key] = 'invalid'; continue; }
    const v = raw.trim();
    values[key] = v;
    if (SINGLE_LINE_BAD.test(v)) fields[key] = 'invalid';
    else if (LIMITS[key] && count(v) > LIMITS[key]) fields[key] = 'too_long';
  }
  const rawMessage = read('message');
  if (rawMessage === null) fields.message = 'invalid';
  else {
    values.message = rawMessage.replace(/\r\n?/g, '\n').trim();
    if (MULTI_LINE_BAD.test(values.message)) fields.message = 'invalid';
    else if (count(values.message) > LIMITS.message) fields.message = 'too_long';
  }

  for (const key of ['name', 'email', 'service', 'message']) {
    if (!fields[key] && values[key] === '') fields[key] = 'missing';
  }
  if (!fields.email && !EMAIL_RE.test(values.email)) fields.email = 'invalid';
  if (!fields.service && !Object.hasOwn(SERVICES, values.service)) fields.service = 'invalid';
  return { values, fields };
}

// Honeypot filled (or not a string): a bot, answered with a silent success.
export function isHoneypot(body) {
  if (body.website !== undefined && typeof body.website !== 'string') return true;
  return typeof body.website === 'string' && body.website.trim() !== '';
}

// Fill time (elapsed ms, measured on the page) under the minimum, or not a whole number. No elapsed (no JS) passes.
export function isTooFast(body, minFillMs) {
  if (body.elapsed === undefined || body.elapsed === '') return false;
  const elapsed = typeof body.elapsed === 'string' && /^\d+$/.test(body.elapsed.trim()) ? Number(body.elapsed) : NaN;
  return !Number.isFinite(elapsed) || elapsed < minFillMs;
}

// In-memory sliding window per IP.
export function createRateLimiter({ max, windowMs, now }) {
  const hits = new Map();
  const prune = (key, t) => {
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  const timer = setInterval(() => { const t = now(); for (const key of [...hits.keys()]) prune(key, t); }, 10 * 60 * 1000);
  timer.unref();
  return {
    take(key) {
      const t = now();
      const list = prune(key, t);
      if (list.length >= max) return { ok: false, retryAfter: Math.ceil((list[0] + windowMs - t) / 1000) };
      list.push(t);
      hits.set(key, list);
      return { ok: true };
    },
  };
}

// TRUST_PROXY: number of proxy hops (default 1, the address the proxy appended), or "false".
export function trustProxyFromEnv(env) {
  const raw = String(env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'false') return false;
  return 1;
}

// SMTP settings from env; returns null when the form cannot send.
export function mailConfigFromEnv(env) {
  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
  const missing = required.filter((k) => !env[k] || !String(env[k]).trim());
  const port = Number(env.SMTP_PORT);
  if (!missing.length && !(Number.isInteger(port) && port > 0 && port < 65536)) missing.push('SMTP_PORT');
  if (missing.length) return { config: null, missing };
  const secureRaw = String(env.SMTP_SECURE || '').trim().toLowerCase();
  const secure = secureRaw ? ['true', '1', 'yes'].includes(secureRaw) : port === 465;
  return {
    missing: [],
    config: {
      transport: {
        host: env.SMTP_HOST.trim(),
        port,
        secure,
        requireTLS: !secure,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      },
      from: env.MAIL_FROM.trim(),
      to: (env.MAIL_TO || '').trim() || 'info@securitycontrol.nl',
    },
  };
}

// SparkPost HTTP API settings from env; MAIL_FROM must be on a domain verified in SparkPost.
export function sparkpostConfigFromEnv(env) {
  const apiKey = String(env.SPARKPOST_API_KEY || '').trim();
  const missing = ['SPARKPOST_API_KEY', 'MAIL_FROM'].filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) return { config: null, missing };
  // EU is the default (the client's account); only an explicit "us" selects the US API.
  const region = String(env.SPARKPOST_REGION || '').trim().toLowerCase() === 'us' ? 'us' : 'eu';
  return {
    missing: [],
    config: {
      sparkpost: {
        apiKey,
        region,
        baseUrl: region === 'eu' ? 'https://api.eu.sparkpost.com' : 'https://api.sparkpost.com',
        timeoutMs: 10000,
      },
      from: env.MAIL_FROM.trim(),
      to: (env.MAIL_TO || '').trim() || 'info@securitycontrol.nl',
    },
  };
}

// SparkPost when SPARKPOST_API_KEY is set, otherwise SMTP; config is null when the form cannot send.
export function mailRouteFromEnv(env) {
  if (String(env.SPARKPOST_API_KEY || '').trim()) return { route: 'sparkpost', ...sparkpostConfigFromEnv(env) };
  return { route: 'smtp', ...mailConfigFromEnv(env) };
}

// Display name as one header-safe phrase: a quoted string for printable ASCII, else RFC 2047 encoded words.
export function headerPhrase(name) {
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  const words = [];
  let chunk = '';
  for (const ch of name) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(' ');
}

// SparkPost transmission built from the same mail as the SMTP route.
export function buildTransmission(m) {
  const sender = addressparser(m.from)[0] || { address: m.from };
  return {
    options: { transactional: true, open_tracking: false, click_tracking: false },
    recipients: [{ address: { email: m.to } }],
    content: {
      from: sender.name ? { name: sender.name, email: sender.address } : sender.address,
      reply_to: `${headerPhrase(m.replyTo.name)} <${m.replyTo.address}>`,
      subject: m.subject,
      text: m.text,
    },
  };
}

// Sends through the SparkPost API; resolves with the HTTP status, throws with a log-safe code.
export function sparkpostSender({ apiKey, baseUrl, timeoutMs = 10000, fetch: fetchFn }) {
  return {
    async send(m) {
      let res;
      try {
        res = await (fetchFn || globalThis.fetch)(`${baseUrl}/api/v1/transmissions`, {
          method: 'POST',
          headers: { Authorization: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(buildTransmission(m)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw Object.assign(new Error('sparkpost request failed'), { code: `sparkpost=${timeout ? 'timeout' : 'network'}` });
      }
      if (res.body) await res.body.cancel().catch(() => {});
      if (res.status < 200 || res.status > 299) throw Object.assign(new Error('sparkpost refused'), { code: `sparkpost=${res.status}` });
      return `sparkpost=${res.status}`;
    },
  };
}

// Sends through nodemailer; throws with a log-safe code.
function smtpSender(transport) {
  const transporter = nodemailer.createTransport(transport);
  return {
    async send(m) {
      try {
        await transporter.sendMail(m);
      } catch (err) {
        throw Object.assign(new Error('smtp send failed'), { code: `smtp=${String(err && err.code ? err.code : 'unknown').replace(/[^\w-]/g, '')}` });
      }
      return '';
    },
  };
}

export function buildMail(values, lang, { from, to }) {
  const label = SERVICES[values.service];
  const text = [
    'New message from the website contact form.',
    '',
    `Name: ${values.name}`,
    `Email: ${values.email}`,
    `Phone: ${values.phone || '(not given)'}`,
    `Service: ${label}`,
    `Subject: ${values.subject || '(not given)'}`,
    `Page language: ${lang.toUpperCase()}`,
    '',
    'Message:',
    values.message,
    '',
  ].join('\n');
  return {
    from,
    to,
    replyTo: { name: values.name, address: values.email },
    subject: `Website contact form (${lang.toUpperCase()}): ${values.subject || label}`,
    text,
  };
}

// POST /api/contact. Logs carry outcome codes only.
export function contactRouter({ mail, logger, minFillMs, rateLimit, now, sendTimeoutMs = 30000 }) {
  const router = express.Router();
  const sender = !mail ? null : mail.sparkpost ? sparkpostSender(mail.sparkpost) : smtpSender(mail.transport);
  const limiter = createRateLimiter({ ...rateLimit, now });

  const reply = (req, res, lang, code, extra = {}) => {
    const mode = req.wantsJson ? 'json' : 'form';
    logger.info(`contact ${code} ${mode} ${lang}${extra.log ? ` ${extra.log}` : ''}`);
    res.set('Cache-Control', 'no-store');
    if (req.wantsJson) {
      if (code === 'ok') return res.status(200).json({ ok: true });
      const payload = { ok: false, code };
      if (extra.fields) payload.fields = extra.fields;
      return res.status(STATUS[code] || 500).json(payload);
    }
    return res.redirect(303, code === 'ok' ? RESULT_PAGES[lang].ok : RESULT_PAGES[lang].fail);
  };

  router.all('/api/contact', (req, res, next) => {
    req.wantsJson = /application\/json/i.test(req.get('accept') || '');
    if (req.method !== 'POST') {
      res.set('Allow', 'POST');
      return res.status(405).type('text').send('Method not allowed');
    }
    if (!req.is(['application/x-www-form-urlencoded', 'application/json'])) {
      return reply(req, res, langFromReferer(req), 'error', { log: 'content-type' });
    }
    return next();
  });

  router.post(
    '/api/contact',
    express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 50 }),
    express.json({ limit: '32kb' }),
    async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const lang = body.lang === 'nl' ? 'nl' : 'en';

      // Order: honeypot (silent success), field errors, fill time (an error the visitor sees), then sending.
      if (isHoneypot(body)) return reply(req, res, lang, 'ok', { log: 'spam' });
      const { values, fields } = validate(body);
      if (Object.keys(fields).length) return reply(req, res, lang, 'invalid', { fields });
      if (isTooFast(body, minFillMs)) return reply(req, res, lang, 'error', { log: 'too_fast' });
      if (!sender) return reply(req, res, lang, 'unavailable');

      const slot = limiter.take(req.ip || 'unknown');
      if (!slot.ok) {
        res.set('Retry-After', String(slot.retryAfter));
        return reply(req, res, lang, 'rate_limited');
      }

      let timer;
      let sent;
      try {
        sent = await Promise.race([
          sender.send(buildMail(values, lang, mail)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('send timeout'), { code: 'timeout' })), sendTimeoutMs);
          }),
        ]);
      } catch (err) {
        const code = /^(smtp|sparkpost)=[\w-]+$|^timeout$/.test(String(err && err.code)) ? err.code : 'unknown';
        return reply(req, res, lang, 'error', { log: code });
      } finally {
        clearTimeout(timer);
      }
      return reply(req, res, lang, 'ok', { log: sent });
    },
  );

  // Body parser failures (malformed or oversized) end here.
  router.use('/api/contact', (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const code = err.status === 413 ? 'body-too-large' : 'body-parse';
    return reply(req, res, langFromReferer(req), 'error', { log: code });
  });

  return router;
}
