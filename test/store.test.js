import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { fakeClock } from './helpers/clock.js';

function dir(t) {
  const d = mkdtempSync(join(tmpdir(), 'sentry-store-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test('round trip, file mode 0600, foreign keys dropped', async (t) => {
  const d = dir(t);
  const file = join(d, 'sentry.json');
  const store = new Store({ filePath: file });
  await store.load();
  assert.equal(store.readable, true);
  await store.update({ attempt: 1000.4, refs: { 1: { since: 5, ids: ['7'] } } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(
    file,
    JSON.stringify({
      attempt: 1000,
      pausedUntil: -5,
      refused: { mark: 'zz', salt: 'x' },
      refs: {
        1: { since: 5, ids: ['7', 'x', 8] },
        '../2': { since: 1, ids: [] },
        __proto__: { since: 1, ids: [] },
      },
      token: 'nope',
    }),
  );
  const again = new Store({ filePath: file });
  await again.load();
  assert.deepEqual(again.data, {
    attempt: 1000,
    pausedUntil: null,
    refused: null,
    scope: null,
    refs: { 1: { since: 5, ids: ['7'] } },
  });
});

test('unreadable is not empty: never written over; a hung read is bounded and read again later', async (t) => {
  const d = dir(t);
  const file = join(d, 'sentry.json');
  writeFileSync(file, '{"attempt": 1}');
  const clock = fakeClock();
  let calls = 0;
  const store = new Store({
    filePath: file,
    timers: clock.timers,
    readTimeoutMs: 2000,
    fs: {
      readFile: () => {
        calls += 1;
        return new Promise(() => {}); // hangs for ever
      },
    },
  });
  const state = store.load();
  await clock.advance(2000);
  assert.equal(await state, 'unreadable');
  assert.equal(await store.update({ attempt: 5 }), false);
  assert.equal(readFileSync(file, 'utf8'), '{"attempt": 1}');
  store.load();
  assert.equal(calls, 1, 'one read at a time');
});

test('a corrupt file is replaced at the next write', async (t) => {
  const d = dir(t);
  const file = join(d, 'sentry.json');
  writeFileSync(file, '{"attempt": 1');
  const store = new Store({ filePath: file });
  assert.equal(await store.load(), 'corrupt');
  assert.equal(await store.update({ attempt: 9 }), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).attempt, 9);
});
