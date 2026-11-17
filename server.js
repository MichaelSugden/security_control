import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { mailConfigFromEnv } from './src/contact.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const redirects = JSON.parse(fs.readFileSync(path.join(root, 'redirects.json'), 'utf8'));
const { config: mail, missing } = mailConfigFromEnv(process.env);

if (!mail) {
  console.warn(`contact form: SMTP is not configured (missing ${missing.join(', ')}); the form answers "unavailable"`);
}

// TRUST_PROXY: "true" (default) or the number of proxy hops in front of the app.
const trustRaw = (process.env.TRUST_PROXY || 'true').trim();
const trustProxy = /^\d+$/.test(trustRaw) ? Number(trustRaw) : trustRaw !== 'false';

const app = createApp({ publicDir: path.join(root, 'public'), redirects, mail, trustProxy });
const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, '0.0.0.0', () => console.log(`listening on port ${port}`));
server.requestTimeout = 60000;
server.headersTimeout = 20000;

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
