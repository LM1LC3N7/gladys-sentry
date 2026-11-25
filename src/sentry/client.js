// -----------------------------------------------------------------------------
// The official Sentry API (https://docs.sentry.io/api/), read only, through
// three documented endpoints:
//   GET /api/0/organizations/{org}/projects/   the projects (org:read)
//   GET /api/0/organizations/{org}/issues/     unresolved issues of a project,
//                                              newest first (event:read)
//   GET /api/0/organizations/{org}/stats_v2/   accepted errors of a project,
//                                              hour by hour over 24 h (org:read)
// The token goes in the Authorization header only, to the origin of the
// configuration only (sentry.io, de.sentry.io or the self-hosted URL). One
// request in flight at a time (Sentry limits concurrent requests too). The
// rate limit headers of each answer are read: when Sentry says no request is
// left in the window of a route, the next request of that route waits for the reset (10 s at most, else
// the rest of the round is skipped).
// -----------------------------------------------------------------------------

import { LIMITS, MAX_BYTES, TIMINGS } from '../constants.js';
import { CODES, SentryError, httpGet } from './http.js';
import {
  nextCursor,
  parseIssues,
  parseProjects,
  parseStats,
  rateLimit,
  retryAfterMs,
  serverDate,
  maxTotalHits,
  totalHits,
} from './parse.js';

/** The cap of X-Hits when Sentry does not say it (MAX_HITS_LIMIT of Sentry). */
const HITS_CAP = 1000;

export class SentryClient {
  /**
   * @param {object} options
   * @param {string} options.base API base (origin + path prefix)
   * @param {string} options.token
   * @param {string} options.organization slug
   * @param {Function} [options.request] the HTTP transport (tests inject a fake Sentry)
   * @param {() => number} [options.monotonic]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({
    base,
    token,
    organization,
    request = httpGet,
    monotonic = () => performance.now(),
    timers = globalThis,
  }) {
    this.base = base;
    this.token = token;
    this.organization = organization;
    this.request = request;
    this.monotonic = monotonic;
    this.timers = timers;
    this.closed = false;
    this.chain = Promise.resolve();
    /** route -> monotonic time until which Sentry's window of that route is spent (limits are per route). */
    this.windows = new Map();
    this.waits = new Set();
    this.abort = new AbortController();
    this.sent = 0;
  }

  close() {
    this.closed = true;
    // A request in flight is cut: nothing of this client goes on after a stop.
    this.abort.abort();
    for (const { handle, resolve } of this.waits) {
      this.timers.clearTimeout(handle);
      resolve();
    }
    this.waits.clear();
  }

  path(route) {
    return `${this.base}/api/0/organizations/${encodeURIComponent(this.organization)}/${route}/`;
  }

  /** One request at a time (queued). */
  get(url, route, maxBytes) {
    const run = this.chain.then(() => this.#send(url, route, maxBytes));
    this.chain = run.catch(() => {});
    return run;
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      const entry = { resolve };
      entry.handle = this.timers.setTimeout(() => {
        this.waits.delete(entry);
        resolve();
      }, ms);
      this.waits.add(entry);
    });
  }

  async #send(url, route, maxBytes) {
    if (this.closed) throw new SentryError(CODES.CLOSED, 'Client closed', { route });
    if (this.windows.has(route)) {
      const wait = this.windows.get(route) - this.monotonic();
      if (wait > TIMINGS.WINDOW_WAIT_MAX_MS) {
        throw new SentryError(CODES.LIMITED, 'Sentry rate limit window spent: not sent', {
          route,
          retryAfterMs: wait,
        });
      }
      if (wait > 0) await this.#sleep(wait);
      if (this.closed) throw new SentryError(CODES.CLOSED, 'Client closed', { route });
      this.windows.delete(route);
    }
    this.sent += 1;
    const response = await this.request(url, {
      token: this.token,
      timeout: TIMINGS.REQUEST_MS,
      maxBytes,
      signal: this.abort.signal,
    });
    if (this.closed) throw new SentryError(CODES.CLOSED, 'Client closed', { route });
    const { remaining, resetInMs } = rateLimit(response.headers);
    if (remaining === 0) {
      // The reset unknown: Sentry's windows are short, the next request waits the longest wait.
      this.windows.set(route, this.monotonic() + (resetInMs ?? TIMINGS.WINDOW_WAIT_MAX_MS));
    }
    const { status } = response;
    if (status >= 300 && status <= 399) {
      throw new SentryError(CODES.REDIRECT, `HTTP ${status} (redirect not followed)`, {
        status,
        route,
      });
    }
    if (status < 200 || status > 299) {
      throw new SentryError(CODES.HTTP, `HTTP ${status}`, {
        status,
        route,
        retryAfterMs: retryAfterMs(response.headers),
      });
    }
    let json;
    try {
      json = JSON.parse(response.body?.toString('utf8') ?? '');
    } catch {
      throw new SentryError(CODES.BAD_ANSWER, 'Not JSON', { route });
    }
    return { json, headers: response.headers };
  }

  /** The projects of the organization (LIMITS.PROJECT_PAGES pages of 100 at most). */
  async projects() {
    const list = [];
    let cursor = null;
    let complete = false;
    for (let page = 0; page < LIMITS.PROJECT_PAGES; page += 1) {
      const query = new URLSearchParams({ per_page: String(LIMITS.PROJECT_PAGE) });
      if (cursor) query.set('cursor', cursor);
      const { json, headers } = await this.get(
        `${this.path('projects')}?${query}`,
        'projects',
        MAX_BYTES.PROJECTS,
      );
      const projects = parseProjects(json);
      if (!projects)
        throw new SentryError(CODES.BAD_ANSWER, 'Not a list of projects', { route: 'projects' });
      list.push(...projects);
      cursor = nextCursor(headers);
      if (!cursor) {
        complete = true;
        break;
      }
    }
    const unique = new Map(list.map((p) => [p.id, p]));
    return { projects: [...unique.values()], complete };
  }

  /**
   * The unresolved issues of a project seen in the last 90 days, newest first
   * (LIMITS.ISSUES). `total`: X-Hits when given, the count when the page is
   * the whole list, else null (unknown, never a guess).
   */
  async issues(projectId) {
    const query = new URLSearchParams({
      project: projectId,
      query: 'is:unresolved',
      sort: 'new',
      statsPeriod: '90d',
      limit: String(LIMITS.ISSUES),
    });
    for (const part of ['stats', 'lifetime', 'filtered', 'unhandled'])
      query.append('collapse', part);
    const { json, headers } = await this.get(
      `${this.path('issues')}?${query}`,
      'issues',
      MAX_BYTES.ISSUES,
    );
    const issues = parseIssues(json);
    if (!issues)
      throw new SentryError(CODES.BAD_ANSWER, 'Not a list of issues', { route: 'issues' });
    const hits = totalHits(headers);
    // X-Hits is an estimate, capped at X-Max-Hits (1000 on sentry.io): at the
    // cap the total is unknown, never published as exact.
    const maxHits = maxTotalHits(headers);
    const raw = Array.isArray(json) ? json.length : 0;
    let total = null;
    if (hits !== null && hits >= raw && hits < (maxHits ?? HITS_CAP)) total = hits;
    else if (raw < LIMITS.ISSUES && !nextCursor(headers)) total = raw;
    return { issues: issues.slice(0, LIMITS.ISSUES), total, serverNow: serverDate(headers) };
  }

  /** The accepted errors of a project, hour by hour over the last 24 h. */
  async stats(projectId) {
    const query = new URLSearchParams({
      project: projectId,
      field: 'sum(quantity)',
      groupBy: 'outcome',
      category: 'error',
      outcome: 'accepted',
      interval: '1h',
      statsPeriod: '24h',
    });
    const { json, headers } = await this.get(
      `${this.path('stats_v2')}?${query}`,
      'stats',
      MAX_BYTES.STATS,
    );
    const stats = parseStats(json);
    if (!stats) throw new SentryError(CODES.BAD_ANSWER, 'Not the error counts', { route: 'stats' });
    return { ...stats, serverNow: serverDate(headers) };
  }
}
