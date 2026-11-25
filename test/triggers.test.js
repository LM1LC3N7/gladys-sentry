import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectNewIssues, detectSpike, errorCounts, isSpike } from '../src/triggers.js';

const NOW = Date.parse('2026-11-25T12:30:00Z');
const MIN = 60_000;
const HOUR = 3600_000;
const i = (id, firstSeen) => ({ id: String(id), firstSeen });

test('new issues: the first reading is only a reference', () => {
  const { fresh, ref } = detectNewIssues(null, [i(2, NOW - HOUR), i(1, NOW - 5 * HOUR)], NOW);
  assert.deepEqual(fresh, []);
  assert.deepEqual(ref, { since: NOW - HOUR, ids: ['2', '1'] });
  assert.deepEqual(detectNewIssues(null, [], NOW).ref, { since: NOW, ids: [] });
  assert.equal(detectNewIssues(null, [], null).ref, null, 'no reference without any date');
});

test('new issues: unseen, after the reference (an hour of late arrival), younger than 2 h by Sentry', () => {
  const ref = { since: NOW - 10 * MIN, ids: ['1'] };
  const list = [
    i(5, NOW - 1 * MIN), // new
    i(4, NOW - 65 * MIN), // first seen before the reference, but within the late hour
    i(3, NOW - 71 * MIN), // before the reference minus an hour: not new
    i(2, null), // no date: not new
    i(1, NOW - 2 * MIN), // seen
  ];
  const { fresh, ref: next } = detectNewIssues(ref, list, NOW);
  assert.deepEqual(
    fresh.map((x) => x.id),
    ['5', '4'],
  );
  assert.equal(next.since, NOW - 1 * MIN);
  assert.deepEqual(next.ids.slice(0, 5), ['5', '4', '3', '2', '1']);
  // Sentry's clock says 3 h later: too old.
  assert.deepEqual(detectNewIssues(ref, list, NOW + 3 * HOUR).fresh, []);
  // Exactly 2 h: still new; just over: not.
  assert.equal(detectNewIssues(ref, [i(9, NOW)], NOW + 2 * HOUR).fresh.length, 1);
  assert.equal(detectNewIssues(ref, [i(9, NOW)], NOW + 2 * HOUR + 1).fresh.length, 0);
  // Without Sentry's clock, the reference alone decides.
  assert.equal(detectNewIssues(ref, [i(9, NOW)], null).fresh.length, 1);
  // The reference never goes back.
  assert.equal(detectNewIssues(ref, [i(9, NOW - 20 * MIN)], NOW).ref.since, NOW - 10 * MIN);
});

test('new issues: the remembered ids are bounded', () => {
  const ref = { since: NOW, ids: Array.from({ length: 60 }, (_, k) => String(1000 + k)) };
  const { ref: next } = detectNewIssues(ref, [i(1, NOW + MIN)], NOW + MIN);
  assert.equal(next.ids.length, 60);
  assert.equal(next.ids[0], '1');
});

test('error counts: the current hour plus the share of the previous one still in the last 60 minutes', () => {
  const counts = [...Array(22).fill(10), 100, 40];
  const lastStart = Date.parse('2026-11-25T12:00:00Z');
  assert.deepEqual(errorCounts({ counts, lastStart }, lastStart + 15 * MIN), {
    lastHour: 115,
    day: 360,
    usual: 10,
  });
  assert.equal(errorCounts({ counts, lastStart }, lastStart).lastHour, 140);
  assert.equal(errorCounts({ counts, lastStart }, lastStart + 2 * HOUR).lastHour, 40);
  assert.equal(errorCounts({ counts, lastStart }, lastStart - HOUR).lastHour, 140);
  assert.equal(errorCounts({ counts, lastStart }, null).lastHour, 40, 'unknown end: never more');
});

test('spike: threshold AND three times the usual hour; once; re-armed under half the threshold', () => {
  assert.equal(isSpike({ lastHour: 100, usual: 0 }, 100), true);
  assert.equal(isSpike({ lastHour: 99, usual: 0 }, 100), false);
  assert.equal(isSpike({ lastHour: 300, usual: 100 }, 100), true);
  assert.equal(isSpike({ lastHour: 299, usual: 100 }, 100), false);
  const c = (lastHour) => ({ lastHour, usual: 5 });
  assert.deepEqual(detectSpike(null, c(500), 100), { fire: false, active: true }, 'first reading');
  assert.deepEqual(detectSpike(false, c(500), 100), { fire: true, active: true });
  assert.deepEqual(detectSpike(true, c(500), 100), { fire: false, active: true });
  assert.deepEqual(detectSpike(true, c(50), 100), { fire: false, active: true }, 'half: still on');
  assert.deepEqual(detectSpike(true, c(49), 100), { fire: false, active: false });
  assert.deepEqual(detectSpike(false, c(99), 100), { fire: false, active: false });
});
