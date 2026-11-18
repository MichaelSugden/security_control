# Security Control website (securitycontrol.nl)

Static pages in `public/`, served by a small Node server that also handles the contact form, the
old-URL redirects and the security headers. It runs on Replit (Autoscale deployment) with the source on
GitHub. Form submissions are emailed through SparkPost (or SMTP as the alternative) to the address in
`MAIL_TO`; nothing is stored.

## Structure

```
server.js              start-up: reads env, builds the app, listens on PORT
src/app.js             headers, redirects, static files, 404 and 410 pages
src/contact.js         POST /api/contact: validation, spam checks, rate limit, mail
src/site-index.js      scans public/ at start-up (page folders, inline code hashes for the CSP)
redirects.json         old URL to new URL (301) and removed URLs (410)
public/                the generated site (do not edit by hand)
test/run.js            test runner: suites, case counts, planted-defect proofs
test/suites/           redirects, headers, pages, form, sparkpost
test/fixtures/         the original .htaccess redirect rows, used to check redirects.json
.replit                Replit run and deployment settings
.env.example           names of the environment variables (no values)
```

Requirements: Node 20 or newer (Replit uses Node 22).

## Run locally

```sh
npm ci
npm start                 # http://localhost:3000
```

To test the form against a real mailbox, copy `.env.example` to `.env`, fill it in and run `npm run dev`
(it loads `.env`). Without SMTP settings the server still starts and the form answers `unavailable`, so
the page shows its email fallback.

```sh
npm test                  # all suites; exit code 0 means everything passed
```

Each suite declares how many cases it has, and a count that does not match fails the run. After the
normal run, every suite runs once more against a planted defect (a broken redirect row, a missing
header, a page without a canonical, a disabled spam check) and that run must fail on the named cases.
If a planted run passes, the proof is dead and `npm test` exits 1.

## Environment variables

Set these as Replit Secrets (or in `.env` locally). Never commit values. The form sends through SparkPost
when `SPARKPOST_API_KEY` is set, otherwise through SMTP. With neither configured it answers `unavailable`.

### Mail through SparkPost (the route in use)

| Name | Required | Value |
|---|---|---|
| `SPARKPOST_API_KEY` | yes | API key with the permission "Transmissions: Read/Write" and nothing else |
| `SPARKPOST_REGION` | set it | `eu` (the client's account is EU); EU is also the default, and only `us` selects the US API |
| `MAIL_FROM` | yes | sender on a domain verified in SparkPost, for example `Security Control website <website@securitycontrol.nl>` or `info@securitycontrol.nl` |
| `MAIL_TO` | set it | `bkiepe@securitycontrol.nl`; when empty the code falls back to `info@securitycontrol.nl` |
| `PORT` | no | port to listen on; default 3000 |
| `TRUST_PROXY` | no | number of proxies in front of the app (default `1`), or `false`; the rate limit uses the address the last trusted proxy appended to `X-Forwarded-For`, the https fix the `X-Forwarded-Proto` entry it set |

- **Region:** the client's account is EU (login at app.eu.sparkpost.com), so set `eu`. An empty or unset
  value also means EU (`https://api.eu.sparkpost.com`); only `us` must be set explicitly, for an account
  whose login is at app.sparkpost.com (`https://api.sparkpost.com`). A key from one region is refused by
  the other.
- **Key:** in SparkPost, open API Keys, create a key, and grant only "Transmissions: Read/Write". The app
  sends it in the `Authorization` header to `/api/v1/transmissions` and never logs it.
- **Sending domain:** `securitycontrol.nl` must be added and verified under Sending Domains before the
  first send. Verification needs a DKIM TXT record. That is a mail DNS record, so the client or their DNS
  owner adds it at the DNS host; the web switch-over below never touches mail records.
- Open and click tracking are off and the message is sent as transactional, so the plain-text body
  arrives as written.
- Each request has a 10 second limit. A refusal, a timeout or a network error answers `error` (the
  not-sent page without JS). The log line names the outcome and `sparkpost=<HTTP status>`, `timeout` or
  `network`, never the key, the visitor's data or SparkPost's reply.

### Mail through SMTP (the alternative)

Used only when `SPARKPOST_API_KEY` is empty. `MAIL_TO`, `PORT` and `TRUST_PROXY` work as above.

| Name | Required | Meaning |
|---|---|---|
| `SMTP_HOST` | yes | SMTP server of the sending mailbox |
| `SMTP_PORT` | yes | usually 465 (TLS) or 587 (STARTTLS) |
| `SMTP_SECURE` | no | `true` for TLS on connect; default is `true` on port 465, otherwise `false` with STARTTLS required |
| `SMTP_USER` | yes | mailbox login |
| `SMTP_PASS` | yes | mailbox password |
| `MAIL_FROM` | yes | sender, the mailbox itself, for example `Security Control website <info@securitycontrol.nl>` |

The start-up log names the route in use (and the SparkPost region), or the missing variables of the
chosen route, never their values.

## The contact form

`POST /api/contact`, form fields `name`, `email`, `phone`, `service`, `subject`, `message`, plus the hidden
`lang` (`en` or `nl`), `elapsed` (milliseconds since the page loaded, measured on the page at submit) and
the honeypot `website`.

- Send the body as `application/x-www-form-urlencoded` (a plain form post, or
  `new URLSearchParams(new FormData(form))` with fetch) or as JSON. A `multipart/form-data` body is refused.
- `service` must be `specialised`, `advanced`, `training` or `other`. Required fields: `name`, `email`,
  `service`, `message`. Limits: name 200, email 254, phone 50, subject 200, message 5,000 characters
  (counted after CR LF becomes LF). Line breaks are refused in every field except the message.
- The fields are checked before the mail settings: an invalid form answers `invalid` with its field
  errors even when sending is unavailable, and only a valid form can answer `unavailable`.
- With `Accept: application/json` the reply is `{"ok":true}` (200) or `{"ok":false,"code":...}` with
  `invalid` (422, plus `fields`, a map such as `{"email":"invalid","message":"missing"}` with reasons
  `missing`, `invalid` or `too_long`), `rate_limited` (429), `unavailable` (503) or `error` (502). Read
  the JSON whatever the status code.
- Without that header the server answers 303 to `/en/contact-us/thank-you/` or `/nl/contact/bedankt/` on
  success, and to `/en/contact-us/not-sent/` or `/nl/contact/niet-verzonden/` on any failure.
- Order of checks: honeypot, then the fields, then the fill time, then sending.
  - A filled honeypot gets the success reply but no mail. It is the only silent success: a real visitor
    cannot fill it.
  - Field errors come next, so an empty or wrong form always gets `invalid` with its `fields`, however fast
    it was sent.
  - A valid form sent within 3 seconds of the page loading (`elapsed` under 3000, or not a whole number)
    gets `error` (the not-sent page without JS) and no mail. The page keeps the fields, and the log line
    ends in `too_fast`. A missing `elapsed` (no JS) passes. The time is measured on the page alone, so the
    visitor's device clock does not matter.
- Rate limit: 5 sent messages per IP per hour, kept in memory (it resets when the app restarts or scales
  to a new instance). Invalid, too-fast and honeypot submissions do not count. The IP is the address the proxy appended
  to `X-Forwarded-For` (`TRUST_PROXY`, default 1 hop), never the leftmost one, which a visitor can set.
- The mail goes from `MAIL_FROM` to `MAIL_TO` with Reply-To set to the visitor. The log line for each
  submission holds only the outcome code, the reply type, the language and, on the SparkPost route, the
  HTTP status.

## Rebuild `public/` from the generator

The pages are generated by the site generator kept with the design files (`v2 build/tools/build_site.py`
in the project folder), not edited here.

1. Run the generator with `--target production`; it writes into `public/` of this repository.
2. Do not add a `.placeholder-public` file to the repository root. It marked the placeholder `public/`
   used before the production pages; while it exists, the pages suite skips the 404, result page and
   form checks and fails its marker case, so `npm test` exits 1.
3. Run `npm test` and commit `public/` together with any change to `redirects.json`.

The CSP hashes for inline scripts, style blocks and style attributes are computed from `public/` when the
server starts, so a regenerated page needs no header change. Third-party hosts are not allowed by the CSP.

Asset cache: files outside HTML are sent with `max-age` of one year. The generator adds `?v=<hash>` (the
start of the file's SHA-256) to every CSS, JS, font and image URL, the favicon, share images and JSON-LD
included, so a changed file gets a new URL and returning visitors never keep a stale copy.

## Redirects

`redirects.json` holds 40 old paths that answer one 301 to their new page (the v1 URL map plus the 2020
legacy paths) and 6 paths that answer 410 with the NL 404 page body (`goneLang`: they all come from the
Dutch 2020 site, the root-level ones included). Each path matches with or without its
trailing slash, and the query string is kept. In the same single hop the server also moves
`www.securitycontrol.nl` to the bare host, `http` to `https`, `/` to `/nl/` and a folder URL without its
slash to the slash form. The host and scheme fixes apply only to `securitycontrol.nl` and
`www.securitycontrol.nl` and always point at `https://securitycontrol.nl`; any other host (the `.replit.app`
URL included) gets only the path fixes, so a forged `Host` can never choose the redirect target. Keep the
rows for at least 12 months.

## Deploy

### 1. Push to GitHub

Create an empty private repository on GitHub (no README, no licence), then:

```sh
git remote add origin git@github.com:<account>/securitycontrol-v2.git
git push -u origin main
```

### 2. Import into Replit

1. In Replit, choose Create, then Import from GitHub, and pick the repository.
2. Replit reads `.replit`: Node 22, run command `npm start`, port 3000 mapped to 80.
3. Open Secrets (the padlock in Tools) and add the variables from the SparkPost table above.
4. Press Run and check the preview: pages load, `/healthz` answers `ok`, and the response headers carry
   `X-Robots-Tag: noindex` (any host other than securitycontrol.nl is kept out of search engines).

### 3. Deploy

1. Choose Deploy, then Autoscale. Build command `npm ci --omit=dev`, run command `npm start` (both from
   `.replit`).
2. Add the same Secrets to the deployment if Replit asks.
3. After the deploy, open the `.replit.app` URL and run the checks in step 5 below against it.
4. Rate limit check: send six messages from one connection; the sixth must be refused. Then send from a
   second connection (another network); it must still go through. If every visitor shares one limit,
   Replit has more than one proxy in front of the app: set `TRUST_PROXY` to that number and redeploy.
   Never set it higher than the real number of proxies, or a visitor can choose their own address.
   The scheme is read the same way: `X-Forwarded-Proto` counts from the right by `TRUST_PROXY`, so with
   the default 1 hop the last entry (the one Replit's proxy set) decides, and `http, https` is https. With
   `TRUST_PROXY=false` the header is ignored and the app never redirects to https itself. After the DNS
   switch (step 5.6), check that `curl -sI http://securitycontrol.nl/en/` answers one 301 to
   `https://securitycontrol.nl/en/` and that the https URL answers 200, with no loop.
5. Mail check: send one real message through the EN form on the `.replit.app` URL. It must arrive in the
   inbox of `bkiepe@securitycontrol.nl` with Reply-To set to the address typed in the form. If the page
   says the message was not sent, the deployment log shows `sparkpost=<status>`: 401 or 403 points at the
   key, its permission or the region; 400 or 422 usually means the `MAIL_FROM` domain is not verified.

### 4. Connect the custom domain

In the deployment settings, open Domains, add `securitycontrol.nl` and `www.securitycontrol.nl`, and note
the records Replit gives (an A record and a TXT record for the bare host, and the record for `www`).

### 5. DNS switch-over checklist

1. One day ahead: lower the TTL of the web records (bare host A and `www`) to 300 seconds.
2. Verify the site on the Replit URL first: every page, the 301s, the 404 page, and a real form send in EN
   and NL that arrives at `bkiepe@securitycontrol.nl`.
3. Change only the web records Replit gives: the A and TXT records for the bare host, and `www`.
4. **Never touch MX, SPF, DKIM, DMARC or any other mail record.** Mail keeps running on the current host.
5. Keep the WordPress site running untouched on its current host: it is the rollback target.
6. After the switch (allow for the TTL): check that HTTPS works on both hosts, that
   `curl -sI https://www.securitycontrol.nl/en/faq/` answers 301 to the bare host, that a few old URLs
   (for example `/en/security-services/`) answer one 301 to their new page, that `X-Robots-Tag` is absent
   on securitycontrol.nl, and send one real message through the form.
7. Submit `https://securitycontrol.nl/sitemap.xml` in Google Search Console.

### Rollback

1. Set the web records (A for the bare host, `www`) back to the values used before the switch. Leave the
   mail records alone, as before.
2. Wait for the TTL (300 seconds if it was lowered), then check that securitycontrol.nl serves WordPress
   again.
3. Keep the Replit deployment running so the problem can be fixed and checked on the Replit URL before the
   next attempt. Raise the TTL again once the site is stable on one host.
