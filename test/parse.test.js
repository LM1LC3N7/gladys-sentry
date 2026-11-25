import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText,
  nextCursor,
  parseIso,
  parseIssues,
  parseProjects,
  parseStats,
  rateLimit,
  retryAfterMs,
  serverDate,
  totalHits,
} from '../src/sentry/parse.js';
import { issue, project, statsAnswer } from './helpers/fakeSentry.js';

const NOW = Date.parse('2026-11-25T12:30:00Z');
const DATE = new Date(NOW).toUTCString();

test('Link header: the next cursor only while results="true" (documented pagination)', () => {
  const link = (more) =>
    `<https://sentry.io/api/0/organizations/acme/projects/?&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ` +
    `<https://sentry.io/api/0/organizations/acme/projects/?&cursor=0:100:0>; rel="next"; results="${more}"; cursor="0:100:0"`;
  assert.equal(nextCursor({ link: link(true) }), '0:100:0');
  assert.equal(nextCursor({ link: link(false) }), null);
  assert.equal(nextCursor({}), null);
  // The documentation's example has no cursor attribute: read from the URL.
  assert.equal(
    nextCursor({
      link: '<https://sentry.io/api/0/x/?&cursor=1420837533:0:0>; rel="next"; results="true"',
    }),
    '1420837533:0:0',
  );
  assert.equal(nextCursor({ link: '<x>; rel="next"; results="true"; cursor="a b&c"' }), null);
});

test('rate limit headers against the Date header, never our clock', () => {
  const reset = String(Math.floor(NOW / 1000) + 30);
  assert.deepEqual(
    rateLimit({
      date: DATE,
      'x-sentry-rate-limit-remaining': '0',
      'x-sentry-rate-limit-reset': reset,
    }),
    { remaining: 0, resetInMs: 30_000 },
  );
  assert.deepEqual(
    rateLimit({ 'x-sentry-rate-limit-remaining': '0', 'x-sentry-rate-limit-reset': reset }),
    {
      remaining: 0,
      resetInMs: null,
    },
  );
  assert.deepEqual(rateLimit({ 'x-sentry-rate-limit-remaining': '-1' }), {
    remaining: null,
    resetInMs: null,
  });
  assert.equal(retryAfterMs({ 'retry-after': '120' }), 120_000);
  assert.equal(
    retryAfterMs({ date: DATE, 'retry-after': new Date(NOW + 90_000).toUTCString() }),
    90_000,
  );
  assert.equal(retryAfterMs({ 'retry-after': 'soon' }), null);
  assert.equal(retryAfterMs({ date: DATE, 'x-sentry-rate-limit-reset': reset }), 30_000);
  assert.equal(serverDate({ date: 'garbage' }), null);
  assert.equal(totalHits({ 'x-hits': '42' }), 42);
  assert.equal(totalHits({ 'x-hits': '4.2' }), null);
});

test('projects: id and slug strict, name cleaned; other shapes dropped', () => {
  const list = parseProjects([
    project(1, 'web', 'Web\u0007site\n'),
    { id: 2, slug: 'api', name: 'API' },
    { id: '3', slug: '../x' },
    { id: 'abc', slug: 'ok' },
    { slug: 'noid' },
    null,
    Object.create({ id: '9', slug: 'proto' }),
  ]);
  assert.deepEqual(list, [
    { id: '1', slug: 'web', name: 'Web site', platform: 'javascript' },
    { id: '2', slug: 'api', name: 'API', platform: '' },
  ]);
  assert.equal(parseProjects({ detail: 'x' }), null);
});

test('issues: fields read strictly; a missing date is null, never now', () => {
  const [a, b] = parseIssues([
    issue(5, { firstSeen: NOW, title: 'x'.repeat(500), level: 'fatal' }),
    {
      id: '6',
      title: 'Bad',
      level: 'weird',
      firstSeen: 'yesterday',
      permalink: 'javascript:alert(1)',
    },
    { id: 7 },
  ]);
  assert.equal(a.title.length, 200);
  assert.equal(a.level, 'fatal');
  assert.equal(a.firstSeen, NOW);
  assert.equal(a.permalink, 'https://acme.sentry.io/issues/5/');
  assert.deepEqual(b, {
    id: '6',
    shortId: '',
    title: 'Bad',
    culprit: '',
    level: '',
    firstSeen: null,
    permalink: '',
  });
  assert.equal(parseIssues('x'), null);
  assert.equal(parseIso('2026-11-25'), null);
  assert.equal(cleanText(42, 10), '');
});

test('stats: hourly series summed; empty groups is zero; any other shape refused', () => {
  const counts = Array.from({ length: 24 }, (_, i) => i);
  const parsed = parseStats(statsAnswer(counts, NOW));
  assert.deepEqual(parsed.counts, counts);
  assert.equal(parsed.lastStart, Date.parse('2026-11-25T12:00:00Z'));
  assert.equal(parsed.end, NOW);
  assert.deepEqual(parseStats(statsAnswer(Array(24).fill(0), NOW)).counts, Array(24).fill(0));
  const bad = (mutate) => {
    const answer = statsAnswer(counts, NOW);
    mutate(answer);
    return parseStats(answer);
  };
  assert.equal(
    bad((a) => (a.groups[0].series['sum(quantity)'][3] = -1)),
    null,
  );
  assert.equal(
    bad((a) => (a.groups[0].series['sum(quantity)'][3] = 1.5)),
    null,
  );
  assert.equal(
    bad((a) => (a.groups[0].series['sum(quantity)'][3] = '7')),
    null,
  );
  assert.equal(
    bad((a) => a.groups[0].series['sum(quantity)'].pop()),
    null,
  );
  assert.equal(
    bad((a) => (a.intervals[5] = 'x')),
    null,
  );
  assert.equal(
    bad((a) => a.intervals.splice(5, 1)),
    null,
    'a missing hour',
  );
  assert.equal(
    bad((a) => delete a.groups),
    null,
  );
  // Another outcome than accepted is not counted.
  const other = statsAnswer(counts, NOW);
  other.groups.push({
    by: { outcome: 'filtered' },
    series: { 'sum(quantity)': Array(24).fill(1000) },
  });
  assert.deepEqual(parseStats(other).counts, counts);
});
