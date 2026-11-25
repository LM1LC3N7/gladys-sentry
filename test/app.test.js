// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys, a fake Sentry and a fake
// clock, through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SentryApp } from '../src/app.js';
import { ACTIONS, FEATURES, MAX_TIMER_MS, STORE_FILE } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { buildProjectDevice } from '../src/model.js';
import { fakeClock } from './helpers/clock.js';
import { NOW, TOKEN, createFakeSentry, issue, project } from './helpers/fakeSentry.js';

const SELECTOR = 'sentry';
const ids = createFakeGladys({ selector: SELECTOR });
const BASE = { auth_token: TOKEN, organization: 'acme', region: 'us', refresh_interval: '600' };
const WEB = buildProjectDevice(ids, { id: '1', slug: 'web', name: 'Website' });
const API = buildProjectDevice(ids, { id: '2', slug: 'api', name: 'API' });
const fid = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));
const MIN = 60_000;
const HOUR = 3600_000;

const APPS = new WeakMap();

function makeLogger() {
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map(String).join(' ')}`),
    ]),
  );
  return { logs, logger };
}

async function setup(
  t,
  {
    config = {},
    created = [WEB, API],
    dataDir,
    sentry,
    clock,
    fs,
    getConfigFails = 0,
    origin,
  } = {},
) {
  clock ??= fakeClock({ wall: NOW });
  sentry ??= createFakeSentry({ clock, origin });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE, ...config },
    devices: created,
  });
  if (getConfigFails > 0) {
    const original = gladys.getConfig.bind(gladys);
    // The first call is the SDK's own (before 'connected'); the next ones are ours.
    let calls = 0;
    gladys.getConfig = async () => {
      calls += 1;
      if (calls > 1 && calls <= 1 + getConfigFails) throw new Error('Gladys starting');
      return original();
    };
  }
  const { logs, logger } = makeLogger();
  let ownDir = false;
  if (!dataDir) {
    dataDir = mkdtempSync(join(tmpdir(), 'sentry-app-'));
    ownDir = true;
  }
  const app = new SentryApp({
    gladys,
    logger,
    request: sentry.request,
    dataDir,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    fs,
  });
  if (!APPS.has(t)) {
    APPS.set(t, { apps: [], dirs: [] });
    t.after(async () => {
      const { apps, dirs } = APPS.get(t);
      for (const one of apps) await one.stop();
      for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    });
  }
  APPS.get(t).apps.push(app);
  if (ownDir) APPS.get(t).dirs.push(dataDir);
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  await clock.advance(0);
  return { gladys, sentry, clock, logs, app, dataDir };
}

const last = (gladys, device, key) => gladys.fake.lastState(fid(device, key).external_id);
const statusText = (gladys) => gladys.fake.connectionStatus?.message?.en ?? '';
const storeOf = (dataDir) => JSON.parse(readFileSync(join(dataDir, STORE_FILE), 'utf8'));
const events = (gladys, key) => gladys.fake.sceneEvents.filter((e) => e.key === key);
/** Every armed timer has a finite delay, within what Node honours. */
const timersSane = (clock) =>
  clock.delays().every((d) => Number.isFinite(d) && d >= 0 && d <= MAX_TIMER_MS);

test('start: Discovery of the projects; the first round publishes the created devices', async (t) => {
  const { gladys, sentry, clock } = await setup(t);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]),
    [
      [`ext:${SELECTOR}:project:2`, 'API'],
      [`ext:${SELECTOR}:project:1`, 'Website'],
    ],
  );
  assert.equal(last(gladys, WEB, FEATURES.UNRESOLVED), 2);
  assert.equal(last(gladys, WEB, FEATURES.LATEST_ISSUE), 'Error 11');
  assert.equal(last(gladys, WEB, FEATURES.ERRORS_DAY), 96);
  // 12:30: the current hour (4) plus half of the previous one (2).
  assert.equal(last(gladys, WEB, FEATURES.ERRORS_HOUR), 6);
  assert.equal(last(gladys, API, FEATURES.UNRESOLVED), 0);
  assert.equal(last(gladys, API, FEATURES.LATEST_ISSUE), '-');
  assert.equal(last(gladys, API, FEATURES.ERRORS_HOUR), 0);
  assert.equal(sentry.count('projects'), 1);
  assert.equal(sentry.count('issues'), 2);
  assert.equal(sentry.count('stats'), 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(statusText(gladys), /2\/2 projects read, 2 unresolved issues/);
  assert.equal(gladys.fake.sceneEvents.length, 0, 'never an event at the first reading');
  assert.ok(timersSane(clock));
});

test('the token goes in the Authorization of the configured origin only, never in a URL, log, status or /data', async (t) => {
  const { gladys, sentry, logs, dataDir, clock } = await setup(t);
  sentry.fail.issues = 500;
  await clock.advance(10 * MIN);
  for (const r of sentry.log) {
    assert.equal(r.token, TOKEN);
    assert.ok(r.url.startsWith('https://sentry.io/api/0/organizations/acme/'), r.url);
    assert.ok(!r.url.includes(TOKEN));
  }
  const secret = TOKEN.slice(8);
  assert.ok(!logs.join('\n').includes(secret));
  assert.ok(!JSON.stringify(gladys.fake.connectionStatuses).includes(secret));
  assert.ok(!readFileSync(join(dataDir, STORE_FILE), 'utf8').includes(secret));
  assert.ok(!JSON.stringify(gladys.fake.requests).includes(secret));
});

test('regions: EU reads de.sentry.io; self-hosted reads its URL and path', async (t) => {
  {
    const clock = fakeClock({ wall: NOW });
    const sentry = createFakeSentry({ clock, origin: 'https://de.sentry.io' });
    const { gladys } = await setup(t, { clock, sentry, config: { region: 'eu' } });
    assert.ok(sentry.log.length > 0);
    assert.ok(sentry.log.every((r) => r.url.startsWith('https://de.sentry.io/api/0/')));
    assert.equal(gladys.fake.connectionStatus.connected, true);
  }
  {
    const clock = fakeClock({ wall: NOW });
    const sentry = createFakeSentry({ clock, origin: 'http://192.168.1.5:9000' });
    const { gladys } = await setup(t, {
      clock,
      sentry,
      config: { region: 'self_hosted', self_hosted_url: 'http://192.168.1.5:9000/' },
    });
    assert.ok(sentry.log.every((r) => r.url.startsWith('http://192.168.1.5:9000/api/0/')));
    assert.equal(gladys.fake.connectionStatus.connected, true);
  }
  {
    const clock = fakeClock({ wall: NOW });
    const sentry = createFakeSentry({ clock });
    const { gladys } = await setup(t, {
      clock,
      sentry,
      config: { region: 'self_hosted', self_hosted_url: 'http://sentry.example.com' },
    });
    assert.equal(sentry.log.length, 0, 'the token never goes over plain http to the Internet');
    assert.equal(gladys.fake.connectionStatus.connected, false);
    assert.match(statusText(gladys), /Plain http is accepted only for a private IP/);
    assert.doesNotMatch(statusText(gladys), /example/);
  }
});

test('rounds every interval, never sooner; a reconnection or a restart does not read sooner', async (t) => {
  const { gladys, sentry, clock, dataDir, app } = await setup(t);
  await clock.advance(9 * MIN);
  assert.equal(sentry.count('issues'), 2);
  await clock.advance(1 * MIN);
  assert.equal(sentry.count('issues'), 4);
  // Gladys goes away 2 min later and comes back: the next round stays 10 min after the last.
  await clock.advance(2 * MIN);
  await gladys.disconnect();
  await gladys.connect();
  await clock.advance(0);
  assert.equal(sentry.count('issues'), 4, 'a reconnection never reads out of turn');
  // A restart of the container (a new app, /data kept).
  await app.stop();
  await setup(t, { clock, sentry, dataDir });
  assert.equal(sentry.count('issues'), 4, 'a restart 2 min after a round waits');
  await clock.advance(7 * MIN);
  assert.equal(sentry.count('issues'), 4);
  await clock.advance(1 * MIN + 1000);
  assert.equal(sentry.count('issues'), 6);
  assert.ok(timersSane(clock));
});

test('the project list is read once an hour, and at the next round after a Scan', async (t) => {
  const { gladys, sentry, clock } = await setup(t);
  await clock.advance(50 * MIN);
  assert.equal(sentry.count('projects'), 1);
  await clock.advance(10 * MIN);
  assert.equal(sentry.count('projects'), 2);
  sentry.projects.push(project(3, 'cron', 'Cron'));
  await gladys.fake.scanRequest();
  assert.equal(sentry.count('projects'), 2, 'a Scan never reads out of turn');
  await clock.advance(10 * MIN);
  assert.equal(sentry.count('projects'), 3);
  assert.ok(gladys.fake.discoveredDevices.some((d) => d.name === 'Cron'));
});

test('new issue: an event for an issue first seen since the last reading, once; a restart neither repeats nor loses it', async (t) => {
  const { gladys, sentry, clock, dataDir } = await setup(t);
  const list = sentry.issues.get('1');
  list.unshift(
    issue(12, { firstSeen: NOW + 5 * MIN, title: 'TypeError: x is undefined', level: 'fatal' }),
  );
  await clock.advance(10 * MIN);
  const [event] = events(gladys, 'new_issue');
  assert.deepEqual(event.data, {
    project: `ext:${SELECTOR}:project:1`,
    level: 'fatal',
    project_name: 'Website',
    issue_title: 'TypeError: x is undefined',
    issue_short_id: 'WEB-12',
    issue_level: 'fatal',
    issue_url: 'https://acme.sentry.io/issues/12/',
  });
  await clock.advance(10 * MIN);
  assert.equal(events(gladys, 'new_issue').length, 1, 'never twice');
  assert.deepEqual(storeOf(dataDir).refs['1'].ids.slice(0, 3), ['12', '11', '10']);
  // Stopped; an issue arrives; restarted: announced once, the old ones not again.
  const first = APPS.get(t).apps[0];
  await first.stop();
  list.unshift(issue(13, { firstSeen: NOW + 25 * MIN }));
  await clock.advance(10 * MIN);
  const again = await setup(t, { clock, sentry, dataDir });
  await clock.advance(1000);
  assert.deepEqual(
    events(again.gladys, 'new_issue').map((e) => e.data.issue_short_id),
    ['WEB-13'],
  );
});

test('new issue: never at the first reading, nor for an issue older than 2 h (Sentry clock), nor more than 5 a project', async (t) => {
  const { gladys, sentry, clock, logs } = await setup(t);
  const list = sentry.issues.get('1');
  // First seen 3 h ago, reaching the list now (resolved then regressed, or late): not new.
  list.unshift(issue(20, { firstSeen: NOW - 3 * HOUR }));
  for (let i = 30; i < 38; i += 1) list.unshift(issue(i, { firstSeen: NOW + 2 * MIN }));
  await clock.advance(10 * MIN);
  const sent = events(gladys, 'new_issue').map((e) => e.data.issue_short_id);
  assert.equal(sent.length, 5);
  assert.ok(!sent.includes('WEB-20'));
  assert.ok(logs.some((l) => /3 new issue\(s\) not announced/.test(l)));
  await clock.advance(10 * MIN);
  assert.equal(events(gladys, 'new_issue').length, 5, 'the rest is never announced late');
});

test('error spike: fires once on the rise, again only after falling under half the threshold', async (t) => {
  const { gladys, sentry, clock } = await setup(t, { config: { spike_threshold: 100 } });
  const counts = sentry.counts.get('1');
  counts[23] = 150; // the current hour
  await clock.advance(10 * MIN);
  const spikes = events(gladys, 'error_spike');
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].data.project, `ext:${SELECTOR}:project:1`);
  assert.equal(spikes[0].data.threshold, 100);
  assert.equal(spikes[0].data.usual_per_hour, 4);
  assert.ok(spikes[0].data.errors_last_hour >= 150);
  counts[23] = 160;
  await clock.advance(10 * MIN);
  assert.equal(events(gladys, 'error_spike').length, 1, 'one event per spike');
  counts[22] = 4;
  counts[23] = 60; // over half the threshold: still the same spike
  await clock.advance(10 * MIN);
  counts[23] = 120;
  await clock.advance(10 * MIN);
  assert.equal(events(gladys, 'error_spike').length, 1);
  counts[23] = 20;
  await clock.advance(10 * MIN);
  counts[23] = 130;
  await clock.advance(10 * MIN);
  assert.equal(events(gladys, 'error_spike').length, 2);
});

test('error spike: not at the first reading, not under three times the usual hour, not after a gap', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const sentry = createFakeSentry({ clock });
  sentry.counts.set(
    '1',
    Array.from({ length: 24 }, () => 200),
  );
  sentry.counts.get('1')[23] = 500;
  const { gladys } = await setup(t, { clock, sentry });
  assert.equal(events(gladys, 'error_spike').length, 0, 'first reading');
  sentry.counts.get('1')[23] = 550; // 550 + 100 < 3 x 200
  await clock.advance(10 * MIN);
  assert.equal(events(gladys, 'error_spike').length, 0);
});

test('Sentry refuses the token (401 on the project list): kept in /data, nothing sent again, lifted by a test or a new configuration', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const sentry = createFakeSentry({ clock });
  sentry.tokens.clear();
  const { gladys, dataDir, app } = await setup(t, { clock, sentry });
  assert.equal(sentry.count('projects'), 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(statusText(gladys), /refused the token/);
  assert.match(storeOf(dataDir).refused.mark, /^[0-9a-f]{2}$/);
  assert.ok(timersSane(clock));
  await clock.advance(5 * HOUR);
  assert.equal(sentry.log.length, 1, 'nothing sent again');
  // A restart with the same token: still nothing.
  await app.stop();
  const again = await setup(t, { clock, sentry, dataDir });
  await clock.advance(HOUR);
  assert.equal(sentry.log.length, 1);
  // The token works again (re-created): the test button lifts the refusal.
  sentry.tokens.add(TOKEN);
  const answer = await again.gladys.fake.action(ACTIONS.TEST, {});
  assert.match(JSON.stringify(answer), /2 projects visible/);
  await clock.advance(0);
  assert.equal(storeOf(dataDir).refused, null);
  await clock.advance(10 * MIN);
  assert.ok(sentry.count('issues') >= 2, 'readings resume');
});

test('the same token saved again in the configuration is tried again after a refusal', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const sentry = createFakeSentry({ clock });
  sentry.tokens.clear();
  const { gladys } = await setup(t, { clock, sentry });
  await clock.advance(HOUR);
  assert.equal(sentry.log.length, 1);
  sentry.tokens.add(TOKEN); // re-enabled in Sentry
  await gladys.fake.configUpdated({ ...BASE });
  await clock.advance(1000);
  assert.ok(sentry.count('issues') >= 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a new token saved in the configuration is tried at once, even after a refusal', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const sentry = createFakeSentry({ clock });
  sentry.tokens.clear();
  const { gladys } = await setup(t, { clock, sentry });
  assert.equal(sentry.log.length, 1);
  sentry.tokens.add('sntryu_new');
  await gladys.fake.configUpdated({ ...BASE, auth_token: 'sntryu_new' });
  await clock.advance(10 * MIN);
  assert.ok(sentry.count('issues') >= 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('401/403 on the issues of one project is not a refusal: the others read, the list asked again', async (t) => {
  const { gladys, sentry, clock, dataDir } = await setup(t);
  sentry.fail.issues = [403];
  await clock.advance(10 * MIN);
  assert.equal(storeOf(dataDir).refused, null);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(statusText(gladys), /Some readings failed \(HTTP error 403\)/);
  await clock.advance(10 * MIN);
  assert.equal(sentry.count('projects'), 2, 'the list (primary route) is asked at the next round');
  sentry.fail.stats = 401;
  await clock.advance(10 * MIN);
  assert.equal(storeOf(dataDir).refused, null);
  assert.ok(last(gladys, WEB, FEATURES.UNRESOLVED) === 2, 'the issues still published');
});

test('a failing secondary reading is spaced out (doubling), never blocking the others', async (t) => {
  const { gladys, sentry, clock } = await setup(t);
  sentry.fail.stats = 'notjson';
  const statsBefore = sentry.count('stats');
  await clock.advance(10 * MIN);
  assert.equal(sentry.count('stats'), statsBefore + 2);
  await clock.advance(10 * MIN);
  assert.equal(sentry.count('stats'), statsBefore + 2, 'waits twice the interval');
  sentry.issues.get('1').unshift(issue(40, { firstSeen: NOW + 15 * MIN }));
  await clock.advance(10 * MIN);
  assert.equal(last(gladys, WEB, FEATURES.UNRESOLVED), 3);
});

test('HTTP 429: every request waits Retry-After (60 s at least), kept in /data across a restart', async (t) => {
  const { gladys, sentry, clock, dataDir, app } = await setup(t);
  sentry.fail.issues = [{ status: 429, headers: { 'retry-after': '1800' } }];
  await clock.advance(10 * MIN);
  const sent = sentry.log.length;
  assert.match(statusText(gladys), /Sentry asked to slow down: next request in 30 min/);
  assert.ok(storeOf(dataDir).pausedUntil > clock.now());
  await app.stop();
  const again = await setup(t, { clock, sentry, dataDir });
  await clock.advance(25 * MIN);
  assert.equal(sentry.log.length, sent, 'nothing during the pause, restart included');
  // The test button does not send either.
  const answer = await again.gladys.fake.action(ACTIONS.TEST, {});
  assert.match(JSON.stringify(answer), /slow down/);
  assert.equal(sentry.log.length, sent);
  await clock.advance(6 * MIN);
  assert.ok(sentry.log.length > sent);
});

test('HTTP 5xx: every request pauses a minute, doubling while it lasts; a success resets it', async (t) => {
  const { gladys, sentry, clock } = await setup(t);
  sentry.fail.issues = [503];
  await clock.advance(10 * MIN);
  assert.match(statusText(gladys), /next request in 1 min/);
  const a = sentry.log.length;
  await clock.advance(9 * MIN);
  assert.equal(sentry.log.length, a, 'the rest waits the next round');
  sentry.fail.issues = [502];
  await clock.advance(1 * MIN);
  assert.match(statusText(gladys), /next request in 2 min/, 'doubled');
  sentry.fail.issues = [];
  await clock.advance(10 * MIN);
  sentry.fail.issues = [500];
  await clock.advance(10 * MIN);
  assert.match(statusText(gladys), /next request in 1 min/, 'reset by the successes');
  assert.ok(timersSane(clock));
});

test('rate limit headers: no request left -> the next waits for the reset; a far reset ends the round, resumed where it stopped', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const sentry = createFakeSentry({ clock });
  sentry.rate = { remaining: 0, resetIn: 5 };
  const { gladys, app } = await setup(t, { clock, sentry });
  await clock.advance(30_000);
  const times = sentry.log.map((r) => r.at);
  assert.equal(times.length, 5);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= 4_900, 'waited');
  assert.equal(sentry.count('issues'), 2);
  const before = sentry.log.length;
  // Spent on the third request of the round (the issues of the second project).
  sentry.rate = { remaining: 0, resetIn: 600, from: before + 2 };
  await clock.advance(10 * MIN);
  assert.equal(sentry.log.length, before + 3, 'the round ends when the window is spent');
  assert.equal(app.round, null, 'never a wait of 10 min inside a round');
  const stoppedAt = sentry.log.at(-1).url;
  sentry.rate = null;
  await clock.advance(10 * MIN);
  // The next round starts with the project where the last one stopped.
  const next = sentry.log.slice(before + 3);
  assert.ok(next.length > 0);
  assert.equal(
    new URL(next[0].url).searchParams.get('project'),
    new URL(stoppedAt).searchParams.get('project'),
  );
  assert.ok(gladys.fake.connectionStatus.connected);
});

test('getConfig failing in "connected": tried again every 30 s, then starts', async (t) => {
  const { gladys, sentry, clock, logs } = await setup(t, { getConfigFails: 2 });
  assert.equal(sentry.log.length, 0);
  assert.ok(logs.some((l) => /Start failed/.test(l)));
  assert.deepEqual(clock.delays(), [30_000]);
  await clock.advance(30_000);
  assert.equal(sentry.log.length, 0);
  await clock.advance(30_000);
  assert.ok(sentry.count('projects') === 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('incomplete configuration: a clear status, no request, no timer', async (t) => {
  for (const [config, text] of [
    [{ auth_token: '' }, /Enter a Sentry auth token/],
    [{ auth_token: 'abc​def' }, /invisible character/],
    [{ organization: '' }, /slug of your Sentry organization/],
    [{ organization: 'Acme Corp!' }, /organization slug is not valid/],
    [{ region: 'self_hosted', self_hosted_url: '' }, /URL of your self-hosted Sentry/],
  ]) {
    const clock = fakeClock({ wall: NOW });
    const sentry = createFakeSentry({ clock });
    const { gladys } = await setup(t, { clock, sentry, config });
    assert.equal(sentry.log.length, 0);
    assert.match(statusText(gladys), text);
    assert.doesNotMatch(statusText(gladys), /Acme Corp/);
    assert.equal(gladys.fake.connectionStatus.connected, false);
    assert.deepEqual(clock.delays(), []);
  }
});

test('projects: a filter by slug (missing ones counted), 20 at most without one', async (t) => {
  {
    const { gladys } = await setup(t, { config: { projects: 'api, nope, Bad_Slug!' } });
    assert.deepEqual(
      gladys.fake.discoveredDevices.map((d) => d.name),
      ['API'],
    );
    assert.match(statusText(gladys), /1 listed project was not found/);
    assert.match(statusText(gladys), /1 invalid entry ignored/);
    assert.doesNotMatch(statusText(gladys), /nope|Bad/);
  }
  {
    const clock = fakeClock({ wall: NOW });
    const sentry = createFakeSentry({ clock });
    sentry.pageSize = 10;
    sentry.projects = Array.from({ length: 25 }, (_, i) =>
      project(100 + i, `p${String(i).padStart(2, '0')}`),
    );
    const { gladys } = await setup(t, { clock, sentry, created: [] });
    assert.equal(gladys.fake.discoveredDevices.length, 20);
    assert.equal(sentry.count('projects'), 3, 'pages followed by the Link header');
    assert.match(statusText(gladys), /5 more projects are not followed/);
    assert.ok(sentry.count('issues') <= 20);
  }
});

test('unknown stays unknown: no X-Hits and a full page -> the unresolved count is not published', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const sentry = createFakeSentry({ clock });
  sentry.hits = false;
  sentry.issues.set(
    '1',
    Array.from({ length: 30 }, (_, i) => issue(500 - i, { firstSeen: NOW - (i + 1) * HOUR })),
  );
  const { gladys } = await setup(t, { clock, sentry });
  assert.equal(last(gladys, WEB, FEATURES.UNRESOLVED), undefined);
  assert.equal(last(gladys, API, FEATURES.UNRESOLVED), 0, 'an empty list is known complete');
  assert.match(statusText(gladys), /2\/2 projects read\./);
});

test('the test button: once a minute at most; problems said in English', async (t) => {
  const { gladys, sentry } = await setup(t);
  const before = sentry.count('projects');
  const ok = await gladys.fake.action(ACTIONS.TEST, {});
  assert.match(JSON.stringify(ok), /Connected to Sentry: 2 projects visible/);
  const again = await gladys.fake.action(ACTIONS.TEST, {});
  assert.match(JSON.stringify(again), /try again in/);
  assert.equal(sentry.count('projects'), before + 1);
});

test('device created: its states from a reading younger than the interval only', async (t) => {
  const { gladys, clock, app } = await setup(t, { created: [] });
  assert.equal(gladys.fake.states.length, 0, 'nothing published for a device not created');
  await app.deviceCreated(WEB);
  assert.equal(gladys.fake.lastState(fid(WEB, FEATURES.UNRESOLVED).external_id), 2);
  const n = gladys.fake.states.length;
  // Past the interval, nothing stale is published.
  await clock.advance(10 * MIN - 1000);
  const fresh = gladys.fake.states.length;
  assert.ok(fresh >= n);
  gladys.forgetPublishedStates?.();
  app.readings.get('2').issuesAt -= 11 * MIN;
  app.readings.get('2').countsAt -= 11 * MIN;
  await app.deviceCreated(API);
  assert.equal(
    gladys.fake.states.length,
    fresh,
    'a reading older than the interval is not republished',
  );
});

test('error spike: after a gap (no reading for more than two intervals), the state is only a reference', async (t) => {
  const { gladys, sentry, clock } = await setup(t);
  sentry.fail.stats = 'notjson'; // spaced out: 20, 40, 60 min...
  await clock.advance(40 * MIN);
  sentry.fail.stats = undefined;
  sentry.counts.get('1')[23] = 500;
  await clock.advance(60 * MIN);
  assert.ok(sentry.count('stats') > 2);
  assert.equal(events(gladys, 'error_spike').length, 0);
});

test('scene events: 30 per round at most, every project together', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const sentry = createFakeSentry({ clock });
  sentry.projects = Array.from({ length: 8 }, (_, k) => project(k + 1, `p${k + 1}`));
  for (let k = 1; k <= 8; k += 1) sentry.issues.set(String(k), []);
  const { gladys } = await setup(t, { clock, sentry, created: [] });
  for (let k = 1; k <= 8; k += 1) {
    for (let n = 0; n < 6; n += 1) {
      sentry.issues
        .get(String(k))
        .unshift(issue(k * 100 + n, { firstSeen: NOW + MIN, projectId: String(k) }));
    }
  }
  await clock.advance(10 * MIN);
  assert.equal(events(gladys, 'new_issue').length, 30);
});

test('schedule(): never a timer on a non-finite delay, capped otherwise', async (t) => {
  const { app, clock, logs } = await setup(t);
  const before = clock.delays().length;
  assert.equal(
    app.schedule(Infinity, () => {}),
    null,
  );
  assert.equal(
    app.schedule(NaN, () => {}),
    null,
  );
  assert.equal(clock.delays().length, before);
  assert.ok(logs.some((l) => /delay not finite/.test(l)));
  app.schedule(1e12, () => {});
  assert.ok(clock.delays().every((d) => d <= MAX_TIMER_MS));
});

test('/data unreadable: the first round waits a whole interval and nothing is written over', async (t) => {
  const clock = fakeClock({ wall: NOW });
  const sentry = createFakeSentry({ clock });
  const dataDir = mkdtempSync(join(tmpdir(), 'sentry-data-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  writeFileSync(join(dataDir, STORE_FILE), '{"attempt": 1}');
  const fs = {
    readFile: async () => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    },
  };
  const { gladys } = await setup(t, { clock, sentry, dataDir, fs });
  assert.equal(sentry.log.length, 0);
  assert.match(statusText(gladys), /\/data unreadable/);
  await clock.advance(10 * MIN);
  assert.equal(sentry.count('projects'), 1);
  assert.equal(readFileSync(join(dataDir, STORE_FILE), 'utf8'), '{"attempt": 1}');
});

test('a stop leaves no timer and sends nothing after', async (t) => {
  const { sentry, clock, app } = await setup(t);
  sentry.fail.stats = 'hang';
  const round = clock.advance(10 * MIN);
  await round;
  await app.stop();
  const sent = sentry.log.length;
  assert.deepEqual(
    clock.delays().filter((d) => d > 20_000),
    [],
    'no round timer left',
  );
  await clock.advance(HOUR);
  assert.equal(sentry.log.length, sent);
});
