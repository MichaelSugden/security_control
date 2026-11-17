import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Walks public/ once at start-up: page folders, HTML files and the inline code the CSP must allow.
export function indexSite(publicDir) {
  const pageDirs = new Set();
  const htmlFiles = [];
  const walk = (dir, urlPath) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, `${urlPath}${entry.name}/`);
      } else if (entry.name.endsWith('.html')) {
        htmlFiles.push(full);
        if (entry.name === 'index.html') pageDirs.add(urlPath);
      }
    }
  };
  walk(publicDir, '/');
  return { pageDirs, htmlFiles, inline: collectInline(htmlFiles) };
}

const sha256 = (text) => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;

const decodeEntities = (s) =>
  s.replace(/&(quot|apos|#39|lt|gt|amp);/g, (m, e) => ({ quot: '"', apos: "'", '#39': "'", lt: '<', gt: '>', amp: '&' })[e]);

// Inline scripts, style blocks and style attributes, as CSP hash sources.
export function collectInline(htmlFiles) {
  const scripts = new Set();
  const styleBlocks = new Set();
  const styleAttrs = new Set();
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const attrs = m[1];
      if (/\ssrc\s*=/i.test(attrs)) continue;
      const type = (attrs.match(/\stype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
      if (type && !/^(text\/javascript|module|application\/javascript)$/i.test(type)) continue;
      scripts.add(sha256(m[2]));
    }
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) styleBlocks.add(sha256(m[1]));
    for (const m of html.matchAll(/<[a-z][^>]*?\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
      styleAttrs.add(sha256(decodeEntities(m[2] ?? m[3])));
    }
  }
  return { scripts: [...scripts].sort(), styleBlocks: [...styleBlocks].sort(), styleAttrs: [...styleAttrs].sort() };
}
