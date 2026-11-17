import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import compression from 'compression';
import { indexSite } from './site-index.js';
import { contactRouter } from './contact.js';

export const CANONICAL_HOST = 'securitycontrol.nl';

export function buildCsp({ scripts, styleBlocks, styleAttrs }) {
  const style = ["'self'", ...styleBlocks];
  if (styleAttrs.length) style.push("'unsafe-hashes'", ...styleAttrs);
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...scripts].join(' ')}`,
    `style-src ${style.join(' ')}`,
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

// Turns redirects.json into lookups that match each old path with and without its trailing slash.
export function loadRedirects(data) {
  const map = new Map();
  for (const { from, to } of data.redirects) {
    map.set(from, to);
    map.set(from.replace(/\/$/, ''), to);
  }
  const gone = new Set();
  for (const p of data.gone) {
    gone.add(p);
    gone.add(p.replace(/\/$/, ''));
  }
  return { map, gone };
}

export function createApp(options) {
  const {
    publicDir,
    redirects,
    mail = null,
    logger = console,
    minFillMs = 3000,
    rateLimit = { max: 5, windowMs: 60 * 60 * 1000 },
    trustProxy = true,
    now = Date.now,
  } = options;

  const site = indexSite(publicDir);
  const csp = buildCsp(site.inline);
  const { map, gone } = loadRedirects(redirects);
  const readPage = (rel) => {
    const file = path.join(publicDir, rel);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  };
  const notFound = { en: readPage('404.html'), nl: readPage('nl/404.html') };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.set('etag', 'strong');

  // Security headers on every response.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'Strict-Transport-Security': 'max-age=31536000',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': PERMISSIONS_POLICY,
    });
    const host = (req.get('host') || '').toLowerCase().replace(/:\d+$/, '');
    if (host !== CANONICAL_HOST) res.set('X-Robots-Tag', 'noindex');
    next();
  });

  app.use(compression());

  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').type('text').send('ok');
  });

  app.use(contactRouter({ mail, logger, minFillMs, rateLimit, now }));

  const sendNotFound = (req, res, status) => {
    const lang = req.path === '/nl' || req.path.startsWith('/nl/') ? 'nl' : 'en';
    res.status(status).set('Cache-Control', 'no-cache');
    const body = notFound[lang] || notFound.en;
    if (body) return res.type('html').send(body);
    return res.type('text').send(status === 410 ? 'Gone' : 'Not found');
  };

  // Host, scheme, old-URL and trailing-slash fixes, combined into a single 301.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const rawUrl = req.originalUrl;
    const q = rawUrl.indexOf('?');
    const pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const search = q === -1 ? '' : rawUrl.slice(q);

    if (gone.has(pathname)) return sendNotFound(req, res, 410);

    let target = pathname;
    if (map.has(pathname)) target = map.get(pathname);
    else if (pathname === '/') target = '/nl/';
    else if (!pathname.endsWith('/') && site.pageDirs.has(`${pathname}/`)) target = `${pathname}/`;

    const host = req.get('host') || '';
    const wwwFix = /^www\./i.test(host);
    const httpsFix = (req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase() === 'http';
    if (target === pathname && !wwwFix && !httpsFix) return next();

    const location = wwwFix || httpsFix
      ? `https://${host.replace(/^www\./i, '')}${target}${search}`
      : `${target}${search}`;
    return res.redirect(301, location);
  });

  app.use(
    express.static(publicDir, {
      index: 'index.html',
      redirect: false,
      dotfiles: 'ignore',
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000');
      },
    }),
  );

  app.use((req, res) => sendNotFound(req, res, 404));

  app.use((err, req, res, next) => {
    logger.error(`server error ${err && err.status ? err.status : 500}`);
    if (res.headersSent) return next(err);
    return res.status(err && err.status && err.status < 500 ? err.status : 500).type('text').send('Server error');
  });

  return app;
}
