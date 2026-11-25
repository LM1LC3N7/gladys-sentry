// -----------------------------------------------------------------------------
// The answers of the Sentry API, read strictly (pure). Anything not as
// documented is dropped: an unknown value stays unknown, never a 0. Texts are
// bounded and stripped of control characters; objects are read with
// Object.hasOwn (no prototype key reaches the code).
// -----------------------------------------------------------------------------

import { LIMITS, PROJECT_ID_PATTERN, SLUG_PATTERN } from '../constants.js';

const own = (obj, key) =>
  obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined;

/** A display text: controls removed, spaces collapsed, bounded. '' when none. */
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = value.slice(0, max * 4).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
  const trimmed = flat.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** An ISO-8601 date of the API -> ms, or null. */
export function parseIso(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const header = (headers, name) => {
  const value = headers?.[name];
  return typeof (Array.isArray(value) ? value[0] : value) === 'string'
    ? (Array.isArray(value) ? value[0] : value).trim()
    : null;
};

/** The `Date` header of an answer (Sentry's clock) -> ms, or null when unreadable. */
export function serverDate(headers) {
  const value = header(headers, 'date');
  if (!value || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const digits = (value, max = 12) =>
  typeof value === 'string' && new RegExp(`^\\d{1,${max}}$`).test(value) ? Number(value) : null;

/**
 * The rate limit headers (documented: X-Sentry-Rate-Limit-Remaining, -Reset in
 * UTC epoch seconds). -> { remaining, resetInMs } (each null when absent).
 * The reset is compared with the `Date` header of the same answer, never with
 * our clock; without a readable Date, it is unknown.
 */
export function rateLimit(headers) {
  const remaining = digits(header(headers, 'x-sentry-rate-limit-remaining'), 9);
  const reset = digits(header(headers, 'x-sentry-rate-limit-reset'), 11);
  const now = serverDate(headers);
  const resetInMs = reset !== null && now !== null ? Math.max(0, reset * 1000 - now) : null;
  return { remaining, resetInMs };
}

/**
 * The wait an HTTP 429 or 503 asks for, in ms, or null: Retry-After (seconds or
 * an HTTP date, against the Date header), else the rate limit reset.
 */
export function retryAfterMs(headers) {
  const retry = header(headers, 'retry-after');
  if (retry !== null) {
    // A huge value is capped (the pause has a ceiling anyway), never ignored.
    if (/^\d{10,30}$/.test(retry)) return 1e12;
    const seconds = digits(retry, 9);
    if (seconds !== null) return seconds * 1000;
    const at = Date.parse(retry);
    const now = serverDate(headers);
    if (Number.isFinite(at) && now !== null) return Math.max(0, at - now);
  }
  return rateLimit(headers).resetInMs;
}

/**
 * The cursor of the next page from the Link header, or null when there is
 * none (`results="false"`, documented: no more results).
 */
export function nextCursor(headers) {
  const link = header(headers, 'link');
  if (!link || link.length > 4000) return null;
  for (const part of link.split(',')) {
    if (!/rel="next"/.test(part)) continue;
    if (!/results="true"/.test(part)) return null;
    const match = /cursor="([^"]{1,200})"/.exec(part) ?? /[?&]cursor=([^&>]{1,200})/.exec(part);
    if (!match) return null;
    const cursor = decodeURIComponent(match[1]);
    return /^[A-Za-z0-9:._-]{1,200}$/.test(cursor) ? cursor : null;
  }
  return null;
}

/** The `X-Hits` header (the total of a search, when Sentry gives it) or null. */
export function totalHits(headers) {
  return digits(header(headers, 'x-hits'), 9);
}

/** The `X-Max-Hits` header (the cap of X-Hits) or null. */
export function maxTotalHits(headers) {
  return digits(header(headers, 'x-max-hits'), 9);
}

/** A page of the project list -> [{ id, slug, name, platform }] or null when not a list. */
export function parseProjects(json) {
  if (!Array.isArray(json)) return null;
  const list = [];
  for (const item of json.slice(0, LIMITS.PROJECT_PAGE)) {
    const id = own(item, 'id');
    const slug = own(item, 'slug');
    const idText = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
    if (typeof idText !== 'string' || !PROJECT_ID_PATTERN.test(idText)) continue;
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) continue;
    list.push({
      id: idText,
      slug,
      name: cleanText(own(item, 'name'), LIMITS.NAME) || slug,
      platform: cleanText(own(item, 'platform'), 40),
    });
  }
  return list;
}

const LEVELS = new Set(['fatal', 'error', 'warning', 'info', 'debug', 'sample']);

/** A page of issues -> [{ id, shortId, title, culprit, level, firstSeen, permalink }] or null. */
export function parseIssues(json) {
  if (!Array.isArray(json)) return null;
  const list = [];
  for (const item of json.slice(0, LIMITS.ISSUES * 2)) {
    const id = own(item, 'id');
    if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) continue;
    const level = own(item, 'level');
    const permalink = own(item, 'permalink');
    const shortId = own(item, 'shortId');
    list.push({
      id,
      shortId: typeof shortId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(shortId) ? shortId : '',
      title: cleanText(own(item, 'title'), LIMITS.TITLE),
      culprit: cleanText(own(item, 'culprit'), LIMITS.TITLE),
      level: LEVELS.has(level) ? level : '',
      firstSeen: parseIso(own(item, 'firstSeen')),
      permalink:
        typeof permalink === 'string' && /^https?:\/\/[^\s"<>]{1,500}$/.test(permalink)
          ? permalink
          : '',
    });
  }
  return list;
}

/**
 * The answer of stats_v2 for one project (groupBy=outcome, outcome=accepted,
 * category=error, interval=1h, statsPeriod=24h) -> { counts: [n per hour,
 * oldest first], lastStart, end } or null when not as documented. An empty
 * `groups` is zero errors (Sentry sends no row for nothing).
 */
export function parseStats(json) {
  const intervals = own(json, 'intervals');
  const groups = own(json, 'groups');
  if (!Array.isArray(intervals) || !Array.isArray(groups)) return null;
  if (intervals.length < 2 || intervals.length > 30 || groups.length > 10) return null;
  const starts = intervals.map(parseIso);
  if (starts.some((s) => s === null)) return null;
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i] - starts[i - 1] !== 3600_000) return null;
  }
  const counts = intervals.map(() => 0);
  for (const group of groups) {
    const outcome = own(own(group, 'by'), 'outcome');
    if (outcome !== undefined && outcome !== 'accepted') continue;
    const series = own(own(group, 'series'), 'sum(quantity)');
    if (!Array.isArray(series) || series.length !== counts.length) return null;
    for (const [i, value] of series.entries()) {
      if (!Number.isSafeInteger(value) || value < 0 || value > LIMITS.COUNT_MAX) return null;
      counts[i] += value;
    }
  }
  return { counts, lastStart: starts.at(-1), end: parseIso(own(json, 'end')) };
}
