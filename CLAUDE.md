# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Sentry: a Node.js service
(Node 22+, ESM, no build step) in its own sandboxed Docker container, talking
to Gladys through `@gladysassistant/integration-sdk`, its only runtime
dependency, and to the Sentry API (sentry.io US / EU, or self-hosted) with a
read-only personal auth token. Sentry is under the FSL: only its public API is
called, nothing of its code is copied.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint
npm run format:check
npx github:GladysAssistant/integration-store .   # store admission checks
node scripts/mutants.mjs                  # mutation check (slow, use memcap)
```

## Architecture

```
index.js               SDK wiring only
src/handlers.js        the SDK handlers -> the app (shared with the tests)
src/app.js             SentryApp: rounds, pauses, refusal, triggers, status, Discovery
src/config.js          configuration (token, region, URL, organization, projects), pure
src/model.js           devices, features and states, pure
src/triggers.js        new issue and error spike decisions, pure
src/store.js           /data: last round, pause, refusal mark, trigger references
src/i18n.js            statuses and messages (en, fr)
src/sentry/http.js     the only network access (one GET, bounded, no redirect)
src/sentry/client.js   the three documented endpoints, one request at a time
src/sentry/parse.js    the answers and headers, read strictly
test/                  node --test, fake Gladys, fake Sentry, fake and real clocks
scripts/mutants.*      mutation check of the guards (not in the image)
```

## Rules

- **External ids are forever**: `project:<Sentry project id>` and the feature
  keys of `src/constants.js`; the scene trigger keys and their field and
  variable keys. Never rename one.
- **The token** goes in the `Authorization` header, to the configured origin
  only; never in a URL, a log, a status, an error message nor `/data`.
  Redirects are never followed.
- **Unknown stays unknown**: an answer not as documented publishes nothing,
  never a 0.
- **Clocks**: the monotonic clock paces rounds, pauses and gaps; the wall
  clock only dates `/data`; Sentry's `Date` header decides the age of an issue
  and the rate limit reset. Every timer goes through `schedule()` (a finite,
  capped delay, or none).
- **Never faster than the interval**, even after a restart, a reconnection, a
  Scan or the test button (one request a minute at most).
- **Refusal** only on HTTP 401 of the project list; kept in `/data`; lifted
  by a saved configuration or a successful test.
- **Versions** belong to the Release workflow, except 0.1.0 set by hand.
- **Changelog** under `## [Unreleased]`; user texts bilingual (en, fr).
- **Style**: Prettier, ESLint; comments explain why, in English; tests never
  touch the network beyond loopback, and every wait in a test is bounded.
