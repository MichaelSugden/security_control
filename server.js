import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { mailRouteFromEnv, trustProxyFromEnv } from './src/contact.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const redirects = JSON.parse(fs.readFileSync(path.join(root, 'redirects.json'), 'utf8'));
const { route, config: mail, missing } = mailRouteFromEnv(process.env);

// Names the route and any missing variables, never their values.
if (!mail) {
  console.warn(`contact form: ${route === 'sparkpost' ? 'SparkPost' : 'SMTP'} is not configured (missing ${missing.join(', ')}); the form answers "unavailable"`);
} else {
  console.log(`contact form: mail goes through ${route === 'sparkpost' ? `SparkPost (${mail.sparkpost.region.toUpperCase()} region)` : 'SMTP'}`);
}

const trustProxy = trustProxyFromEnv(process.env);

const app = createApp({ publicDir: path.join(root, 'public'), redirects, mail, trustProxy });
const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, '0.0.0.0', () => console.log(`listening on port ${port}`));
server.requestTimeout = 60000;
server.headersTimeout = 20000;

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
