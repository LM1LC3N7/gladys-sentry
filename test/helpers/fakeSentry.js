// -----------------------------------------------------------------------------
// A fake Sentry API, shaped after the official documentation (docs.sentry.io/api):
// the project list, the organization issues and stats_v2, a Link header with
// `results="true|false"`, the rate limit headers and a `Date` header from the
// test clock. It plugs in as the HTTP transport of the app (`request`).
//
//   sentry.fail.issues = 500           every issues request answers 500
//   sentry.fail.projects = [401]       the next projects request answers 401 (a list: one each)
//   sentry.fail.stats = 'hang'         never answers (the request rejects after its timeout)
//   sentry.headers = { ... }           extra headers on every answer
// -----------------------------------------------------------------------------

import { CODES, SentryError } from '../../src/sentry/http.js';

export const TOKEN = 'sntryu_TEST-secret-0123456789abcdef';
export const NOW = Date.parse('2026-11-25T12:30:00Z');
const HOUR = 3600_000;

export function project(id, slug, name = slug) {
  return {
    id: String(id),
    slug,
    name,
    platform: 'javascript',
    dateCreated: '2025-01-01T00:00:00Z',
    hasAccess: true,
    isMember: true,
    features: ['a', 'b'],
  };
}

export function issue(
  id,
  { firstSeen, title = `Error ${id}`, level = 'error', projectId = '1' } = {},
) {
  return {
    id: String(id),
    shortId: `WEB-${id}`,
    title,
    culprit: 'app.js in handler',
    level,
    status: 'unresolved',
    firstSeen: new Date(firstSeen).toISOString(),
    lastSeen: new Date(firstSeen).toISOString(),
    count: '12',
    userCount: 3,
    permalink: `https://acme.sentry.io/issues/${id}/`,
    project: { id: projectId, name: 'web', slug: 'web' },
  };
}

/**
 * The stats_v2 answer as Sentry builds it (`to_intervals` of
 * snuba/sessions_v2.py) for `statsPeriod=24h&interval=1h` asked at `now`: 25
 * hourly intervals, the last one the current hour (partial), and `end`
 * rounded UP to the next hour, never the time of the request.
 */
export function statsAnswer(counts, now) {
  const lastStart = Math.floor(now / HOUR) * HOUR;
  const end = lastStart + HOUR;
  const intervals = counts.map((_, i) =>
    new Date(lastStart - (counts.length - 1 - i) * HOUR).toISOString().replace('.000', ''),
  );
  return {
    start: intervals[0],
    end: new Date(end).toISOString().replace('.000', ''),
    intervals,
    groups: counts.some((n) => n > 0)
      ? [
          {
            by: { outcome: 'accepted' },
            totals: { 'sum(quantity)': counts.reduce((a, b) => a + b, 0) },
            series: { 'sum(quantity)': [...counts] },
          },
        ]
      : [],
  };
}

export function createFakeSentry({
  clock,
  organization = 'acme',
  origin = 'https://sentry.io',
} = {}) {
  const sentry = {
    tokens: new Set([TOKEN]),
    organization,
    origin,
    projects: [project(1, 'web', 'Website'), project(2, 'api', 'API')],
    /** project id -> issues, newest first */
    issues: new Map([
      ['1', [issue(11, { firstSeen: NOW - 5 * HOUR }), issue(10, { firstSeen: NOW - 30 * HOUR })]],
      ['2', []],
    ]),
    /** project id -> 25 hourly counts, the last one the current hour */
    counts: new Map([
      ['1', Array.from({ length: 25 }, () => 4)],
      ['2', Array.from({ length: 25 }, () => 0)],
    ]),
    /** project id -> errors per hour, a number or (hour start ms) => number (instead of `counts`) */
    perHour: new Map(),
    maxHits: 1000,
    hits: true,
    fail: {},
    headers: {},
    rate: null, // { remaining, resetIn (s), from (requests before) } on the answers
    pageSize: null, // projects per page (default: the per_page asked)
    log: [],
    count(route) {
      return sentry.log.filter((r) => r.route === route).length;
    },
  };

  const answer = (status, body, headers = {}) => ({
    status,
    headers: {
      date: new Date(clock.now()).toUTCString(),
      'content-type': 'application/json',
      ...(sentry.rate && sentry.log.length > (sentry.rate.from ?? 0)
        ? {
            'x-sentry-rate-limit-remaining': String(sentry.rate.remaining),
            'x-sentry-rate-limit-reset': String(
              Math.floor(clock.now() / 1000) + sentry.rate.resetIn,
            ),
          }
        : {}),
      ...sentry.headers,
      ...headers,
    },
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  });

  const failure = (route) => {
    const f = sentry.fail[route];
    if (Array.isArray(f)) return f.length > 0 ? f.shift() : undefined;
    return f;
  };

  sentry.request = async (url, { token, timeout, maxBytes } = {}) => {
    const target = new URL(url);
    const prefix = `/api/0/organizations/${sentry.organization}/`;
    const route = target.pathname.startsWith(prefix)
      ? target.pathname.slice(prefix.length).replace(/\/$/, '')
      : target.pathname;
    const name = { projects: 'projects', issues: 'issues', stats_v2: 'stats' }[route] ?? route;
    sentry.log.push({ route: name, url, token, at: clock.monotonic(), timeout, maxBytes });
    const f = failure(name);
    if (f === 'hang') {
      await new Promise((resolve) => clock.timers.setTimeout(resolve, timeout));
      throw new SentryError(CODES.TIMEOUT, 'No answer in time');
    }
    if (f === 'throw') throw new SentryError(CODES.UNREACHABLE, 'ECONNRESET');
    if (f === 'notjson') return answer(200, '<html>');
    if (typeof f === 'object' && f !== null) return answer(f.status, f.body ?? {}, f.headers);
    if (typeof f === 'number') return answer(f, { detail: `Error ${f} ${token}` });
    if (target.origin !== sentry.origin) return answer(404, { detail: 'Not found' });
    if (!sentry.tokens.has(token)) return answer(401, { detail: 'Invalid token' });
    const q = target.searchParams;
    if (!target.pathname.startsWith(prefix)) return answer(404, { detail: 'Not found' });
    if (name === 'projects') {
      const size = sentry.pageSize ?? Number(q.get('per_page'));
      const start = Number(q.get('cursor')?.split(':')[1] ?? 0);
      const page = sentry.projects.slice(start, start + size);
      const more = start + size < sentry.projects.length;
      const link =
        `<${origin}${prefix}projects/?&cursor=0:${Math.max(0, start - size)}:1>; rel="previous"; results="${start > 0}"; cursor="0:${Math.max(0, start - size)}:1", ` +
        `<${origin}${prefix}projects/?&cursor=0:${start + size}:0>; rel="next"; results="${more}"; cursor="0:${start + size}:0"`;
      return answer(200, page, { link });
    }
    if (name === 'issues') {
      const list = sentry.issues.get(q.get('project')) ?? [];
      const limit = Number(q.get('limit'));
      const page = list.slice(0, limit);
      const headers = {
        link: `<${origin}>; rel="next"; results="${list.length > limit}"; cursor="0:${limit}:0"`,
      };
      // As Sentry: an estimate capped at X-Max-Hits (MAX_HITS_LIMIT, api/paginator.py).
      if (sentry.hits) {
        headers['x-hits'] = String(Math.min(list.length, sentry.maxHits));
        headers['x-max-hits'] = String(sentry.maxHits);
      }
      return answer(200, page, headers);
    }
    if (name === 'stats') {
      // The query of the integration, as documented: anything else is a 400.
      const wanted = {
        field: 'sum(quantity)',
        groupBy: 'outcome',
        category: 'error',
        outcome: 'accepted',
        interval: '1h',
        statsPeriod: '24h',
      };
      for (const [key, value] of Object.entries(wanted)) {
        if (q.get(key) !== value) return answer(400, { detail: `Invalid ${key}` });
      }
      const id = q.get('project');
      const rate = sentry.perHour.get(id);
      const now = clock.now();
      let counts = sentry.counts.get(id) ?? Array.from({ length: 25 }, () => 0);
      if (rate !== undefined) {
        // A constant rate: complete hours full, the current one by its elapsed share.
        const lastStart = Math.floor(now / HOUR) * HOUR;
        const at = (start) => (typeof rate === 'function' ? rate(start) : rate);
        counts = Array.from({ length: 25 }, (_, i) => {
          const start = lastStart - (24 - i) * HOUR;
          return i < 24 ? at(start) : Math.floor((at(start) * (now - lastStart)) / HOUR);
        });
      }
      return answer(200, statsAnswer(counts, now));
    }
    return answer(404, { detail: 'Not found' });
  };
  return sentry;
}
