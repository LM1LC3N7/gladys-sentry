# Sentry

Follow the projects of your **Sentry** organization in Gladys: unresolved
issues, errors of the last hour and of the last 24 hours, the newest issue,
and start a scene on a **new issue** or an **error spike**. Works with
sentry.io (US or EU data storage) and with a self-hosted Sentry. Read only:
Gladys never changes anything in Sentry.

Unofficial integration, not affiliated with Sentry. It has **never been tested with a real Sentry** organization: it is written from the official Sentry API
documentation and tested against a simulated Sentry. Reports are welcome.

## What you need

- A Sentry organization, on sentry.io or self-hosted.
- A **personal token**: in Sentry, _User settings_, _Personal Tokens_, _Create
  New Token_, with the read scopes **org:read**, **project:read** and
  **event:read** only (no write scope is needed). An organization token
  (`sntrys_…`) is limited to releases and cannot read issues.

## Configuration

- **Auth token**: kept by Gladys in its database, never shown again, sent only
  to the Sentry chosen below, in the `Authorization` header. It never appears
  in the logs, the status, nor the files of the integration.
- **Where is your Sentry?**: _sentry.io, United States_ (`sentry.io`), _sentry.io,
  European Union_ (`de.sentry.io`: check _Settings_, _General_, _Data Storage
  Location_ of your organization), or _Self-hosted Sentry_.
- **Self-hosted Sentry URL** (self-hosted only): `https://sentry.example.com`,
  with a path if Sentry sits behind a reverse proxy (`https://example.com/sentry`).
  The certificate must be one a browser accepts (a self-signed certificate is
  not supported yet). Plain `http://` is accepted only for a private IP address
  of your network (`http://192.168.1.5:9000`): elsewhere the token would cross
  the Internet in clear.
- **Organization slug**: the short name in your Sentry addresses
  (`https://<slug>.sentry.io` or `/organizations/<slug>/`).
- **Projects** (optional): the slugs of the projects to follow, separated by
  commas, 20 at most. Empty: the first 20 projects of the organization, in slug
  order (the status says how many are left out).
- **Refresh**: every 5, 10 (default), 15, 30 or 60 minutes.
- **Error spike threshold**: 100 errors in the last hour by default (10 to
  1,000,000).

Press **Test the connection**: it reads the project list once (at most once a
minute) and says how many projects the token can see.

## Devices

Each followed project appears in the _Discovery_ tab; add the ones you want.
Features (read only):

- **Unresolved issues**: the unresolved issues seen in the last 90 days. When
  Sentry does not give the total and there are more than 25, the value is not
  published (an unknown count is never shown as a number).
- **Errors in the last hour**: the accepted errors of the current hour, plus
  the share of the previous hour still inside the last 60 minutes.
- **Errors in the last 24 h**.
- **Newest issue**: the title of the most recent unresolved issue (`-` when
  there is none).

## Scene triggers

- **New Sentry issue**: a new unresolved issue, first seen less than 2 hours
  ago by Sentry's clock. Filters: the project, the levels. Variables: project
  name, issue title, short id, level, link. Never at the first reading of a
  project (the issues already there are not "new"); the reference is kept, so a
  restart neither repeats an issue nor loses one first seen less than 2 hours before. Five issues per project and per
  reading at most (a burst only starts five scenes).
- **Sentry error spike**: a project counts, in the last hour, at least the
  threshold **and** three times its usual hour (the mean of the complete
  hours of the day before). Once per spike: it fires again only after the errors went
  under half the threshold. Not at the first reading, nor after a long gap
  without readings (2 intervals). Variables: project name, errors in the last
  hour, usual errors per hour, threshold.

Scenes start up to one refresh interval after the fact.

## Requests and limits

Each round sends two requests per project (its issues, its error counts),
one at a time, plus the project list once an hour (and at the next round after
a Scan). With 20 projects every 10 minutes, that is about 240 requests an
hour. Sentry advises against frequent polling: keep the interval long if you
follow many projects.

- Sentry's rate limit headers are read: when no request is left in Sentry's
  window, the next one waits for the reset (10 s at most, else the rest of the
  round waits for the next round, starting where it stopped).
- **HTTP 429** or **5xx**: every request waits (the `Retry-After` of Sentry,
  else 1 minute doubling while it lasts, 6 hours at most). The pause is kept
  across a restart; the test button does not send during it.
- A failing reading of one project (HTTP 403, 404, an unexpected answer) is
  spaced out, doubling up to an hour; the other projects go on.
- Answers are bounded in size (2 MB for the project list) and in time (15 s);
  redirects are never followed (the token would go along).
- A restart (or Gladys reconnecting) never reads sooner than the interval: the
  time of the last round is kept in `/data`.

## Errors

- **Sentry refused the token (HTTP 401)** on the project list: nothing is sent
  again, even after a restart, until you save a new token in the configuration
  or a press of _Test the connection_ succeeds. A 401 on the issues or the
  counts of one project is not taken as a refusal: the project list is asked
  again at the next round, and only its answer decides.
- **HTTP 403** on the project list: the token lacks a scope (org:read,
  project:read, event:read).
- **HTTP 404**: wrong organization slug, or the wrong region (US / EU).
- **Redirect not followed**: often the wrong region, or an http URL that
  redirects to https.

## Privacy

Gladys keeps in `/data` only the time of the last round, a pause asked by
Sentry, the ids and first-seen dates of the newest issues (for the new issue
trigger) and, after a refusal, 8 bits of a salted fingerprint of the refused
configuration (too little to help guess a token; erased by a success). Issue
titles stay in Gladys (device states, scene variables): they may quote data of
your applications.
