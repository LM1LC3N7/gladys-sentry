# TODO — Sentry v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core** (2026-11-25): the projects of a Sentry
      organization (sentry.io US / EU, or self-hosted) as read-only devices
      (unresolved issues, errors of the last hour and of 24 h, newest issue);
      "new issue" and "error spike" scene triggers; refusal, pauses and the
      last round kept in `/data`; docs en/fr; cover. Tested with unit tests
      against the SDK's fake Gladys, a fake Sentry and loopback HTTP servers
      (real clock sped up). **Never tested with a real Sentry** (self-hosted Sentry needs 16 GB of RAM: not on the development VM). Review r1 compared the paths, parameters, headers, pagination and `stats_v2` intervals with the documentation and with Sentry's source code (getsentry/sentry, read only): fixes in r1.
- [ ] **Milestone 2 — real Sentry** (a sentry.io account, free plan): record
      real answers as fixtures, fix what differs. To check first:
  - `X-Hits` / `X-Max-Hits` of the issues endpoint (undocumented; from Sentry's source: an estimate capped at 1000; without it, a list longer than 100 leaves the unresolved count unknown);
  - the shape of `stats_v2` with `groupBy=outcome` for one project: from Sentry's source (`to_intervals`), `end` is rounded up to the next hour and `statsPeriod=24h` gives 25 intervals, the last one partial; the fake server is built that way and the last 60 minutes are taken against the `Date` header. To confirm, and whether an hour without errors is a 0 in the series or a missing group;
  - the status of a refused token (401) and of a missing scope (403) on each
    route; the status Sentry gives when its rate limit refuses (429 expected,
    without `Retry-After` per Sentry's source, `X-Sentry-Rate-Limit-Reset` only);
  - the `firstSeen` of an issue is the timestamp of its first event (the application's clock): a client clock late by more than the hour of tolerance hides a new issue.
  - whether `sentry.io` answers a EU organization with a redirect or an error.
- [ ] **Milestone 3 — more** (not in v1): self-signed certificate of a
      self-hosted Sentry (fingerprint confirmed by the user); "regression"
      trigger (a resolved issue back); environments filter; webhooks of an
      internal integration through Gladys Plus instead of polling.
- [ ] **Milestone 4 — first release**: Docker image, Release workflow, store
      check, the `gladys-assistant-integration` topic at the first release.

## Decisions

- **Version 0.1.0** set by hand (package.json, lock, manifest,
  `docker_image`, `VERSION` of the User-Agent).
- **SDK `^0.16.1`** (latest on npm, 2026-11-25); **Gladys `>=5.1.0`** (scene
  triggers). No `countries` (sentry.io and self-hosted: everywhere); no
  `keywords`. Category `servers`; transport `cloud` only (declaring `local`
  too would render the "Prefer local" toggle, meaningless here).
- **Sentry is under the FSL**: only its public API is called, from the
  official documentation; nothing is copied (THIRD_PARTY_NOTICES.md).
- **Token**: a personal token with `org:read` (projects, stats) and `event:read` (issues); `project:read` is not needed.
  Organization tokens (`sntrys_`) cannot read issues. In the Authorization
  header only, to the configured origin only; redirects never followed.
- **Regions**: US `https://sentry.io` (the documentation: "your API domain
  should be sentry.io"), EU `https://de.sentry.io`; self-hosted: https, or
  plain http to a private IP literal only (the token in clear on a LAN the
  user owns); a path prefix is kept.
- **Refusal**: 401 on the project list only (primary route), kept in /data as
  8 bits of a salted HMAC of base + organization + token. Lifted by a saved
  configuration (any) or a successful test. A 401/403/404 on issues or stats
  only spaces that reading out and asks the list again at the next round.
- **Requests**: one at a time; the project list hourly (and after a Scan, at
  the next round); 2 per project per round; 20 projects at most. The interval
  is 5 min at the fastest (Sentry's guidance against polling). 429 / 5xx:
  429: pause of every path (Retry-After or the rate limit reset, else 1 min doubling, 1 min to 6 h), in /data; the next round starts after the project that caused it. 5xx on one project: that reading spaced out (next round, then every 2, 4... rounds); 5xx on two projects of a round or on the list: global pause.
  `X-Sentry-Rate-Limit-Remaining: 0`: per route (Sentry limits per caller and route), the next request of that route waits for the reset
  (10 s max, else the round ends and the next starts at the same project).
- **Unresolved count**: `X-Hits` (an estimate) when given and under `X-Max-Hits` (1000 when absent), else the list when complete (< 100 and no next page), else unknown (not published). Issues seen in the last
  90 days (`statsPeriod=90d`: the default period of the endpoint is shorter).
- **Errors of the last hour**: stats_v2 has hourly buckets at best; the last 60 minutes are estimated as the current hour plus the remaining share of the previous one, against the `Date` header (never `end`, rounded up by Sentry). The last 24 h: 24 buckets plus the share of the 25th. The usual hour is the mean of the complete hours before the last two (22 at most).
- **New issue**: the 100 newest unresolved issues read; reference (the time of the last reading by Sentry's `Date`, and 200 ids seen) kept in /data per project, purged for projects no longer followed and dropped for another organization, written before the events; an hour
  of tolerance for late events; 2 h maximum age by Sentry's `Date`; 5 events
  per project and 30 per round at most.
- **Spike**: threshold (configuration, 100 by default) AND 3 x usual;
  hysteresis at half the threshold; state in memory (a restart takes the
  state as a reference, never fires).
- **Timers**: every timer goes through `schedule()`, which refuses a
  non-finite delay and caps at 2^31-1 ms (wave 1 lesson).
