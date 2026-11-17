import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export { assert };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC = path.join(ROOT, 'public');
export const HOST = 'securitycontrol.nl';
export const PLACEHOLDER = fs.existsSync(path.join(ROOT, '.placeholder-public'));
export const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// Starts a handler on a free port.
export function serve(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
    });
  });
}

// One HTTP request with a hard timeout. Never follows redirects.
export function request(port, { method = 'GET', path: p = '/', headers = {}, body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: HOST, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        const buf = enc === 'gzip' ? zlib.gunzipSync(raw) : enc === 'br' ? zlib.brotliDecompressSync(raw) : raw;
        resolve({ status: res.statusCode, headers: res.headers, raw, body: buf, text: buf.toString('utf8') });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout ${method} ${p}`)));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

const tmpDirs = [];
export function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scv2-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}
export function cleanupTmp() {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

// A tiny public/ with known 404 bodies, for the language-selection cases.
export function fixturePublic({ swapLanguages = false } = {}) {
  const dir = tmpDir('fixture');
  const en = '<!doctype html><title>EN 404 fixture</title>';
  const nl = '<!doctype html><title>NL 404 fixture</title>';
  fs.mkdirSync(path.join(dir, 'nl'));
  fs.mkdirSync(path.join(dir, 'en'));
  fs.writeFileSync(path.join(dir, '404.html'), en);
  fs.writeFileSync(path.join(dir, 'nl', '404.html'), swapLanguages ? en : nl);
  fs.writeFileSync(path.join(dir, 'en', 'index.html'), '<!doctype html><title>en</title>');
  fs.writeFileSync(path.join(dir, 'nl', 'index.html'), '<!doctype html><title>nl</title>');
  return { dir, en, nl };
}

// Content pages: sitemap.xml when present, otherwise the placeholder's page folders.
export function contentUrls(publicDir = PUBLIC) {
  const sitemap = path.join(publicDir, 'sitemap.xml');
  if (fs.existsSync(sitemap)) {
    const xml = fs.readFileSync(sitemap, 'utf8');
    return { source: 'sitemap', urls: [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]) };
  }
  const urls = [];
  const walk = (dir, u) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${u}${e.name}/`);
      else if (e.name === 'index.html' && u !== '/') urls.push(`https://${HOST}${u}`);
    }
  };
  walk(publicDir, '/');
  return { source: 'tree', urls: urls.sort() };
}

// Mock mail transport: keeps every built message.
export function mockTransport({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    transport: {
      name: 'mock',
      version: '1',
      send(mail, cb) {
        if (fail) return cb(Object.assign(new Error('connection refused'), { code: 'ECONNECTION' }));
        mail.message.build((err, raw) => {
          if (err) return cb(err);
          sent.push({ data: mail.data, raw: raw.toString('utf8') });
          return cb(null, { messageId: `mock-${sent.length}` });
        });
      },
    },
  };
}
