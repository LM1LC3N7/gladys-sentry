// -----------------------------------------------------------------------------
// The real clock, sped up 500 times, against a real loopback HTTP server (a
// self-hosted Sentry on a private address): the period of the rounds is
// measured (never faster than the interval, never a cycle late), and a stop
// leaves nothing behind. Every wait is bounded: the test fails, never hangs.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SentryApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { realClock } from './helpers/clock.js';
import { project, statsAnswer } from './helpers/fakeSentry.js';

const SPEED = 500;
const TOKEN = 'sntryu_realclock';

test('rounds every 5 min (real clock x500), measured; a stop leaves no timer nor request', async (t) => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(performance.now());
    res.setHeader('content-type', 'application/json');
    res.setHeader('date', new Date().toUTCString());
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end('{}');
    } else if (req.url.includes('/projects/')) res.end(JSON.stringify([project(1, 'web')]));
    else if (req.url.includes('/issues/')) res.end('[]');
    else res.end(JSON.stringify(statsAnswer(Array(25).fill(1), Date.now())));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  const clock = realClock({ speed: SPEED });
  t.after(() => clock.close());
  const dataDir = await mkdtemp(join(tmpdir(), 'sentry-real-'));
  const gladys = createFakeGladys({
    selector: 'sentry',
    config: {
      auth_token: TOKEN,
      organization: 'acme',
      region: 'self_hosted',
      self_hosted_url: `http://127.0.0.1:${server.address().port}`,
      refresh_interval: '300',
    },
  });
  const app = new SentryApp({
    gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    dataDir,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  t.after(async () => {
    await app.stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });
  // The decision, not the requests (their latency blurs the period): each
  // round records its attempt first.
  const rounds = [];
  const update = app.store.update.bind(app.store);
  app.store.update = (values) => {
    if ('attempt' in values) rounds.push(clock.monotonic());
    return update(values);
  };
  registerHandlers(gladys, app, null);
  await gladys.connect();
  const deadline = performance.now() + 20_000;
  while (rounds.length < 6 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await app.stop();
  assert.ok(rounds.length >= 6, `${rounds.length} rounds`);
  const gaps = rounds.slice(1).map((at, i) => at - rounds[i]);
  for (const gap of gaps) {
    assert.ok(gap >= 300_000 - 500, `gap ${Math.round(gap)} ms: faster than the interval`);
    assert.ok(gap <= 300_000 * 1.5, `gap ${Math.round(gap)} ms: a cycle late`);
  }
  const sent = app.client.sent;
  // A request already on the wire at the stop may still reach the server: counted after.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const count = hits.length;
  await new Promise((resolve) => setTimeout(resolve, 1_500)); // 750 simulated s
  assert.equal(hits.length, count, 'nothing after stop');
  assert.equal(app.client.sent, sent, 'no request started after stop');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
