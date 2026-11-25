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
      (real clock sped up). **Never tested with a real Sentry** (self-hosted
      Sentry needs 16 GB of RAM: not on the development VM).
- [ ] **Milestone 2 — real Sentry** (a sentry.io account, free plan): record
      real answers as fixtures, fix what differs. To check first:
  - whether the issues endpoint sends `X-Hits` (undocumented; without it,
    a list longer than 25 leaves the unresolved count unknown);
  - the shape of `stats_v2` with `groupBy=outcome` for one project, whether
    `end` is the request time (used for the last 60 minutes), and whether an
    hour without errors is a 0 in the series or a missing group;
  - the status of a refused token (401) and of a missing scope (403) on each
    route; the status Sentry gives when its rate limit refuses (429 expected,
    with or without `Retry-After`);
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
- **Token**: a personal token with `org:read`, `project:read`, `event:read`.
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
  pause of every path (Retry-After, else 1 min doubling, 6 h max), in /data.
  `X-Sentry-Rate-Limit-Remaining: 0`: the next request waits for the reset
  (10 s max, else the round ends and the next starts at the same project).
- **Unresolved count**: `X-Hits` when given, else the list when complete (< 25
  and no next page), else unknown (not published). Issues seen in the last
  90 days (`statsPeriod=90d`: the default period of the endpoint is shorter).
- **Errors of the last hour**: stats_v2 has hourly buckets at best; the last
  60 minutes are estimated as the current hour plus the remaining share of
  the previous one. The usual hour is the mean of the complete hours before
  those two.
- **New issue**: reference (newest first-seen and the ids of the last page,
  60 at most) kept in /data per project, written before the events; an hour
  of tolerance for late events; 2 h maximum age by Sentry's `Date`; 5 events
  per project and 30 per round at most.
- **Spike**: threshold (configuration, 100 by default) AND 3 x usual;
  hysteresis at half the threshold; state in memory (a restart takes the
  state as a reference, never fires).
- **Timers**: every timer goes through `schedule()`, which refuses a
  non-finite delay and caps at 2^31-1 ms (wave 1 lesson).
