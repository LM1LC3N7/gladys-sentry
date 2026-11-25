// -----------------------------------------------------------------------------
// SentryApp: the integration. One Sentry organization (sentry.io US or EU, or
// a self-hosted Sentry), read with an auth token, its projects as devices.
//
//   start(config)  (re)starts: /data read, rounds scheduled
//   rounds         every `refresh_interval` (10 min by default): the project
//                  list (every hour, or after a Scan), then for each followed
//                  project (20 at most) its unresolved issues and its error
//                  counts: two requests, one at a time
//   scene events   "new issue" and "error spike" (src/triggers.js)
//   test button    one reading of the project list, once a minute at most;
//                  the only path that sends a token Sentry refused
//
// Two clocks: `monotonic` paces the rounds, the pauses and the gaps (a wall
// clock set back or forward never stops nor hurries them); `now` (wall) only
// dates what /data keeps. Sentry's own clock (`Date` header) decides the age
// of an issue.
//
// Sentry refusing the token (HTTP 401 on the project list, the primary route)
// is final: kept in /data, nothing is sent again until the configuration is
// saved or "Test the connection" succeeds. A 401/403/404 on the issues or the
// counts of one project only spaces that reading out (doubling up to 1 h) and
// asks the project list again at the next round. HTTP 429 and 5xx pause every
// request (Retry-After, else doubling from 1 min, 6 h at most), kept in /data.
//
// Every run belongs to a generation: a restart or a stop bumps it, and the
// result of an older run is dropped after each await. Every timer goes
// through schedule(), which never arms one on a non-finite delay.
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { configProblem, normalizeConfig } from './config.js';
import { LIMITS, MAX_TIMER_MS, SCENE_TRIGGERS, STORE_FILE, TIMINGS } from './constants.js';
import { T, reasonOf } from './i18n.js';
import { buildProjectDevice, parseExternalId, projectIds, projectStates } from './model.js';
import { SentryClient } from './sentry/client.js';
import { CODES, SentryError } from './sentry/http.js';
import { Store } from './store.js';
import { detectNewIssues, detectSpike, errorCounts } from './triggers.js';

const isPausing = (err) =>
  err?.code === CODES.HTTP && (err.status === 429 || (err.status >= 500 && err.status <= 599));

export class SentryApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake Sentry)
   * @param {string} [options.dataDir] the writable volume
   * @param {() => number} [options.now] wall clock (ms), only for /data
   * @param {() => number} [options.monotonic] monotonic clock (ms)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   * @param {object} [options.fs] file functions of the store (tests)
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'sentry' }),
    request,
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    fs,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = new Store({
      filePath: join(dataDir, STORE_FILE),
      logger,
      readTimeoutMs: TIMINGS.DATA_READ_MS,
      timers,
      fs,
    });
    this.config = normalizeConfig();
    this.client = null;
    this.generation = 0;
    this.running = false;
    this.handles = new Set();
    this.tickHandle = null;
    this.queue = Promise.resolve();
    this.round = null;
    this.lastTestAt = null;
    this.reset();
  }

  reset() {
    /** { followed: [project], total, missing, notFollowed, at (monotonic) } or null */
    this.projects = null;
    this.projectsError = null;
    this.projectsWanted = true;
    this.refused = false;
    this.pauseUntil = null;
    this.pauses = 0;
    this.failures = 0;
    this.dueAt = null;
    this.rotation = 0;
    /** project id -> { issues, issuesAt, counts, countsAt, error } */
    this.readings = new Map();
    /** `${project id}:${route}` -> { failures, nextAt (monotonic) } */
    this.backoff = new Map();
    /** project id -> { active, at (monotonic) } */
    this.spikes = new Map();
    this.lastStatus = null;
    /** [monotonic, count] of the states published in the last minute */
    this.published = [];
  }

  // --- Lifecycle ---------------------------------------------------------------

  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /** (Re)start with a configuration; `force` (configuration saved) tries a refused token again. */
  start(rawConfig, { force = false } = {}) {
    return this.enqueue(() => this.run(rawConfig, force));
  }

  async stop() {
    this.generation += 1;
    this.running = false;
    this.halt();
    this.client?.close();
    // The write in progress ends before the container does (2 s at most:
    // a hung /data never holds the shutdown).
    let handle;
    await Promise.race([
      this.store.flushed(),
      new Promise((resolve) => (handle = setTimeout(resolve, 2_000))),
    ]);
    clearTimeout(handle);
  }

  /** Clears every timer of the current generation. */
  halt() {
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
    this.tickHandle = null;
  }

  /** The only way a timer is armed: a finite delay, bounded, or none at all. */
  schedule(delay, task) {
    if (!Number.isFinite(delay)) {
      this.logger.error('Timer not armed: delay not finite');
      return null;
    }
    const handle = this.timers.setTimeout(
      async () => {
        this.handles.delete(handle);
        try {
          await task();
        } catch (err) {
          this.logger.error(`Loop failed: ${this.describe(err)}`);
        }
      },
      Math.min(MAX_TIMER_MS, Math.max(0, delay)),
    );
    this.handles.add(handle);
    return handle;
  }

  /** A start that failed before reading the configuration: again later, never without a timer. */
  retryStart(task) {
    this.halt();
    this.schedule(TIMINGS.CONFIG_RETRY_MS, task);
  }

  describe(err) {
    if (err instanceof SentryError) return err.message;
    return `${err?.name ?? 'Error'}: ${String(err?.message ?? '').slice(0, 200)}`;
  }

  /** 8 bits of an HMAC of what Sentry refused (see src/store.js). */
  mark(salt) {
    const { base, organization, token } = this.config;
    return createHmac('sha256', salt)
      .update(`${base}\n${organization}\n${token}`)
      .digest('hex')
      .slice(0, 2);
  }

  async run(rawConfig, force) {
    this.halt();
    this.client?.close();
    const generation = ++this.generation;
    this.running = true;
    this.config = normalizeConfig(rawConfig);
    this.reset();
    this.gladys.forgetPublishedStates?.();
    await this.store.load();
    if (generation !== this.generation) return;
    const { base, organization, token, intervalMs } = this.config;
    this.client = new SentryClient({
      base,
      token,
      organization,
      monotonic: this.monotonic,
      timers: this.timers,
      ...(this.request ? { request: this.request } : {}),
    });
    const problem = configProblem(this.config);
    if (problem) {
      this.logger.warn(`Configuration incomplete (${problem}): nothing read`);
    } else {
      await this.restore(force, generation);
      if (generation !== this.generation) return;
      this.logger.info(
        `Reading Sentry organization ${organization} (${this.config.region}) every ${intervalMs / 1000} s`,
      );
    }
    if (!this.store.readable) this.scheduleStoreRetry(generation);
    await this.publishDiscovery();
    await this.updateStatus();
    if (!problem) this.scheduleTick(generation);
  }

  /** What /data says: refusal, pause, the next round, the references. */
  async restore(force, generation) {
    const scope = `${this.config.base}\n${this.config.organization}`;
    if (this.store.readable && this.store.get('scope') !== scope) {
      // Another organization or Sentry: the references of the old one mean nothing.
      await this.within(this.store.update({ scope, refs: {} }), TIMINGS.DATA_READ_MS).catch(
        () => {},
      );
      if (generation !== this.generation) return;
    }
    const refused = this.store.get('refused');
    if (refused && !force && this.mark(refused.salt) === refused.mark) {
      this.refused = true;
      this.logger.warn('Sentry refused this token before: nothing sent until a new one or a test');
    }
    const mono = this.monotonic();
    const wall = this.now();
    const pausedUntil = this.store.get('pausedUntil');
    if (pausedUntil !== null && pausedUntil > wall) {
      const left = pausedUntil - wall;
      // Further than the longest pause: a clock set back, invalid.
      if (left <= TIMINGS.PAUSE_MAX_MS) this.pauseUntil = mono + left;
    }
    const { intervalMs } = this.config;
    let delay = 0;
    if (!this.store.readable) {
      delay = intervalMs; // the last attempt is unknown: a whole interval, never sooner
    } else {
      const last = this.store.get('attempt');
      // A time in the future (a clock set back) is invalid: read now.
      if (last !== null && last <= wall)
        delay = Math.min(intervalMs, Math.max(0, last + intervalMs - wall));
    }
    this.dueAt = mono + delay;
  }

  /** /data unreadable: read again every 10 s (one read at a time) until it is. */
  scheduleStoreRetry(generation) {
    this.schedule(TIMINGS.DATA_RETRY_MS, async () => {
      if (generation !== this.generation) return;
      await this.store.load();
      if (generation !== this.generation) return;
      if (this.store.readable) await this.updateStatus();
      else this.scheduleStoreRetry(generation);
    });
  }

  /** The next round, when it is due (and the pause over); none while refused. */
  scheduleTick(generation) {
    if (generation !== this.generation || !this.running) return;
    if (this.tickHandle !== null) {
      this.timers.clearTimeout(this.tickHandle);
      this.handles.delete(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.refused || this.dueAt === null || configProblem(this.config)) return;
    const at = Math.max(this.dueAt, this.pauseUntil ?? -Infinity);
    this.tickHandle = this.schedule(at - this.monotonic(), async () => {
      this.tickHandle = null;
      await this.tick();
    });
  }

  /** Resolves `promise`, or rejects after `ms` (the promise keeps running). */
  within(promise, ms, message = 'Too long') {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  // --- Rounds ------------------------------------------------------------------

  /** One round at a time; a round of an older generation never stands for this one. */
  tick() {
    const generation = this.generation;
    if (this.round?.generation === generation) return this.round.promise;
    const promise = this.readRound().finally(() => {
      if (this.round?.promise === promise) this.round = null;
    });
    this.round = { generation, promise };
    return promise;
  }

  async readRound() {
    const generation = this.generation;
    if (!this.running || this.refused || configProblem(this.config)) return;
    const mono = this.monotonic();
    if (this.pauseUntil !== null && mono < this.pauseUntil) {
      this.scheduleTick(generation);
      return;
    }
    if (this.dueAt !== null && mono < this.dueAt) {
      this.scheduleTick(generation);
      return;
    }
    this.pauseUntil = null;
    // The period runs from the start of the round: never a cycle late.
    this.dueAt = mono + this.config.intervalMs;
    // The attempt is in /data before the first request (bounded: a hung
    // /data never stops the rounds).
    await this.within(
      this.store.update({ attempt: Math.round(this.now()) }),
      TIMINGS.DATA_READ_MS,
    ).catch(() => {});
    if (generation !== this.generation) return;
    try {
      await this.readAll(generation);
    } finally {
      if (generation === this.generation) {
        await this.updateStatus();
        this.scheduleTick(generation);
      }
    }
  }

  async readAll(generation) {
    const mono = this.monotonic();
    if (
      this.projects === null ||
      this.projectsWanted ||
      mono - this.projects.at >= TIMINGS.PROJECTS_EVERY_MS
    ) {
      const ok = await this.readProjects(generation);
      if (generation !== this.generation || ok === 'stop') return;
    }
    if (this.projects === null) return;
    const { followed } = this.projects;
    if (followed.length === 0) return;
    const start = this.rotation % followed.length;
    let events = 0;
    for (let i = 0; i < followed.length; i += 1) {
      const index = (start + i) % followed.length;
      const outcome = await this.readProject(
        followed[index],
        generation,
        LIMITS.EVENTS_PER_ROUND - events,
      );
      if (generation !== this.generation) return;
      if (outcome.stop) {
        // Paused or Sentry's window spent: this project first at the next round.
        this.rotation = index;
        return;
      }
      events += outcome.events;
    }
    this.rotation = 0;
  }

  /** The project list. Resolves 'ok', 'failed' or 'stop' (refused or paused). */
  async readProjects(generation) {
    let result;
    try {
      result = await this.client.projects();
    } catch (err) {
      if (generation !== this.generation) return 'stop';
      return this.projectsFailed(err, generation);
    }
    if (generation !== this.generation) return 'stop';
    await this.projectsRead(result, generation);
    return 'ok';
  }

  async projectsFailed(err, generation) {
    if (err?.code === CODES.CLOSED) return 'stop';
    if (err?.code === CODES.HTTP && err.status === 401) {
      await this.refuse(generation);
      return 'stop';
    }
    if (isPausing(err)) {
      await this.pause(err, generation);
      return 'stop';
    }
    if (err?.code === CODES.LIMITED) return 'stop';
    if (!this.projectsError || this.projectsError.code !== err?.code) {
      this.logger.warn(`Project list not read: ${this.describe(err)}`);
    }
    this.projectsError = err;
    if (this.projects === null) {
      // Nothing to read without it: spaced out, doubling up to an hour.
      this.failures += 1;
      const wait = Math.min(
        TIMINGS.RETRY_MAX_MS,
        this.config.intervalMs * 2 ** Math.min(10, this.failures - 1),
      );
      this.dueAt = this.monotonic() + Math.max(wait, this.config.intervalMs);
      return 'stop';
    }
    return 'failed';
  }

  async projectsRead({ projects, complete }, generation) {
    const { filter } = this.config;
    let followed;
    let missing = 0;
    let notFollowed = 0;
    if (filter) {
      const bySlug = new Map(projects.map((p) => [p.slug, p]));
      followed = filter.slugs.map((s) => bySlug.get(s)).filter(Boolean);
      // A slug absent from an incomplete list (more than 300 projects) is not "missing".
      missing = complete ? filter.slugs.length - followed.length : 0;
    } else {
      const sorted = [...projects].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      followed = sorted.slice(0, LIMITS.PROJECTS);
      notFollowed = sorted.length - followed.length;
    }
    const wasRefused = this.store.get('refused') !== null;
    this.projects = {
      followed,
      total: projects.length,
      missing,
      notFollowed,
      at: this.monotonic(),
    };
    this.projectsError = null;
    this.projectsWanted = false;
    this.failures = 0;
    this.pauses = 0;
    const ids = new Set(followed.map((p) => p.id));
    for (const id of this.readings.keys()) if (!ids.has(id)) this.readings.delete(id);
    if (wasRefused) {
      await this.within(this.store.update({ refused: null }), TIMINGS.DATA_READ_MS).catch(() => {});
      if (generation !== this.generation) return;
    }
    await this.publishDiscovery();
  }

  async refuse(generation) {
    this.refused = true;
    this.logger.warn(
      'Sentry refused the token (HTTP 401): nothing sent until a new token or a test',
    );
    const salt = randomBytes(32).toString('hex');
    await this.within(
      this.store.update({ refused: { mark: this.mark(salt), salt } }),
      TIMINGS.DATA_READ_MS,
    ).catch(() => {});
    if (generation !== this.generation) return;
    this.halt();
  }

  /** HTTP 429 or 5xx: every request waits (Retry-After, else doubling from a minute). */
  async pause(err, generation) {
    this.pauses += 1;
    const asked = Number.isFinite(err?.retryAfterMs) ? err.retryAfterMs : null;
    const wait = Math.min(
      TIMINGS.PAUSE_MAX_MS,
      Math.max(
        TIMINGS.PAUSE_MIN_MS,
        asked ?? TIMINGS.PAUSE_MIN_MS * 2 ** Math.min(10, this.pauses - 1),
      ),
    );
    this.pauseUntil = this.monotonic() + wait;
    this.logger.warn(
      `Sentry answered HTTP ${err.status}: every request waits ${Math.round(wait / 1000)} s`,
    );
    await this.within(
      this.store.update({ pausedUntil: Math.round(this.now() + wait) }),
      TIMINGS.DATA_READ_MS,
    ).catch(() => {});
    if (generation !== this.generation) return;
  }

  /** Whether `${id}:${route}` may be read now (a failing secondary reading waits). */
  allowed(key, mono) {
    const entry = this.backoff.get(key);
    return !entry || mono >= entry.nextAt;
  }

  failed(key) {
    const entry = this.backoff.get(key) ?? { failures: 0, nextAt: 0 };
    entry.failures += 1;
    entry.nextAt =
      this.monotonic() +
      Math.min(TIMINGS.RETRY_MAX_MS, this.config.intervalMs * 2 ** Math.min(10, entry.failures));
    this.backoff.set(key, entry);
  }

  /**
   * The issues and the counts of one project, published; scene events fired.
   * Resolves { stop, events }.
   */
  async readProject(project, generation, eventRoom) {
    const reading = this.readings.get(project.id) ?? {
      issues: null,
      issuesAt: null,
      counts: null,
      countsAt: null,
      errors: { issues: null, stats: null },
    };
    this.readings.set(project.id, reading);
    let events = 0;
    for (const route of ['issues', 'stats']) {
      const key = `${project.id}:${route}`;
      const at = this.monotonic();
      if (!this.allowed(key, at)) continue;
      let result;
      try {
        result =
          route === 'issues'
            ? await this.client.issues(project.id)
            : await this.client.stats(project.id);
      } catch (err) {
        if (generation !== this.generation) return { stop: true, events };
        if (err?.code === CODES.CLOSED || err?.code === CODES.LIMITED)
          return { stop: true, events };
        if (isPausing(err)) {
          await this.pause(err, generation);
          return { stop: true, events };
        }
        if (err?.code === CODES.HTTP && [401, 403, 404].includes(err.status)) {
          // Not a refusal: the project list (the primary route) says, next round.
          this.projectsWanted = true;
        }
        if (reading.errors[route]?.code !== err?.code) {
          this.logger.warn(`${project.slug}: ${route} not read (${this.describe(err)})`);
        }
        reading.errors[route] = err;
        this.failed(key);
        continue;
      }
      if (generation !== this.generation) return { stop: true, events };
      this.backoff.delete(key);
      this.pauses = 0;
      reading.errors[route] = null;
      if (route === 'issues') {
        reading.issues = result;
        reading.issuesAt = at;
        events += await this.newIssues(project, result, generation, eventRoom - events);
      } else {
        const counts = errorCounts(result, result.end ?? result.serverNow);
        const previous = this.spikes.get(project.id);
        reading.counts = counts;
        reading.countsAt = at;
        events += await this.spike(project, counts, previous, at, eventRoom - events);
      }
      if (generation !== this.generation) return { stop: true, events };
      if (this.isCreated(projectIds(this.gladys, project.id).device)) {
        await this.publishStates(
          projectStates(
            this.gladys,
            project.id,
            route === 'issues' ? { issues: result } : { counts: reading.counts },
          ),
        );
      }
      if (generation !== this.generation) return { stop: true, events };
    }
    return { stop: false, events };
  }

  async newIssues(project, result, generation, room) {
    const refs = this.store.get('refs') ?? {};
    const { fresh, ref } = detectNewIssues(
      refs[project.id] ?? null,
      result.issues,
      result.serverNow,
    );
    if (ref) {
      // The reference is in /data before the events: a restart never repeats them.
      await this.within(
        this.store.update({ refs: { ...this.store.get('refs'), [project.id]: ref } }),
        TIMINGS.DATA_READ_MS,
      ).catch(() => {});
      if (generation !== this.generation) return 0;
    }
    if (fresh.length === 0) return 0;
    const allowed = Math.max(0, Math.min(LIMITS.EVENTS_PER_PROJECT, room));
    if (fresh.length > allowed) {
      this.logger.info(
        `${project.slug}: ${fresh.length - allowed} new issue(s) not announced (too many at once)`,
      );
    }
    const device = projectIds(this.gladys, project.id).device;
    let sent = 0;
    for (const issue of fresh.slice(0, allowed)) {
      await this.event(SCENE_TRIGGERS.NEW_ISSUE, {
        project: device,
        level: issue.level || null,
        project_name: project.name,
        issue_title: issue.title || null,
        issue_short_id: issue.shortId || null,
        issue_level: issue.level || null,
        issue_url: issue.permalink || null,
      });
      sent += 1;
    }
    return sent;
  }

  async spike(project, counts, previous, at, room) {
    // A previous reading older than the gap: only a reference.
    const gap = TIMINGS.GAP_INTERVALS * this.config.intervalMs + 60_000;
    const active = previous && at - previous.at <= gap ? previous.active : null;
    const { fire, active: next } = detectSpike(active, counts, this.config.spikeThreshold);
    this.spikes.set(project.id, { active: next, at });
    if (!fire || room < 1) return 0;
    this.logger.info(`${project.slug}: error spike (${counts.lastHour} in the last hour)`);
    await this.event(SCENE_TRIGGERS.ERROR_SPIKE, {
      project: projectIds(this.gladys, project.id).device,
      project_name: project.name,
      errors_last_hour: counts.lastHour,
      usual_per_hour: counts.usual,
      threshold: this.config.spikeThreshold,
    });
    return 1;
  }

  async event(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
    } catch (err) {
      this.logger.warn(`Scene event ${key} not sent: ${this.describe(err)}`);
    }
  }

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((d) => d?.external_id === externalId);
  }

  /** Changed values only, within the state budget of Gladys (the rest waits a reading). */
  async publishStates(list) {
    if (list.length === 0) return;
    const mono = this.monotonic();
    this.published = this.published.filter(([t]) => mono - t < 60_000);
    const used = this.published.reduce((sum, [, count]) => sum + count, 0);
    if (used + list.length > LIMITS.STATES_PER_MINUTE) {
      this.logger.debug('States held back: the rate limit of Gladys is near');
      return;
    }
    try {
      const result = await this.gladys.publishChangedStates(list);
      this.published.push([mono, Number(result?.count) || 0]);
    } catch (err) {
      this.logger.warn(`States not published: ${this.describe(err)}`);
    }
  }

  // --- Status ------------------------------------------------------------------

  async updateStatus() {
    if (!this.running) return;
    const generation = this.generation;
    const notes = [];
    let connected = false;
    const problem = configProblem(this.config);
    if (problem) {
      notes.push(T.problems[problem]);
    } else if (this.refused) {
      notes.push(T.status.refused);
    } else {
      const { filter } = this.config;
      if (filter?.invalid > 0) notes.push(T.status.invalidSlugs(filter.invalid));
      const mono = this.monotonic();
      if (this.pauseUntil !== null && mono < this.pauseUntil) {
        notes.push(T.status.paused(this.pauseUntil - mono));
      }
      if (this.projects === null) {
        const err = this.projectsError;
        if (!err) notes.push(T.status.waiting);
        else if (err.code === CODES.HTTP && err.status === 403) notes.push(T.status.forbidden);
        else if (err.code === CODES.HTTP && err.status === 404) notes.push(T.status.notFound);
        else notes.push(T.status.failing(reasonOf(err)));
      } else {
        const { followed, missing, notFollowed } = this.projects;
        if (followed.length === 0) {
          notes.push(T.status.noProject);
          connected = true;
        } else {
          const readings = followed.map((p) => this.readings.get(p.id)).filter(Boolean);
          const read = readings.filter((r) => r.issues || r.counts);
          const totals = readings.map((r) => r.issues?.total ?? null);
          const unresolved =
            read.length === followed.length && totals.every((t) => t !== null)
              ? totals.reduce((s, t) => s + t, 0)
              : null;
          if (readings.length === 0) notes.push(T.status.waiting);
          else notes.push(T.status.summary(followed.length, read.length, unresolved));
          const failing = readings.flatMap((r) => [r.errors.issues, r.errors.stats]).find(Boolean);
          if (failing) notes.push(T.status.partial(reasonOf(failing)));
          // Everything failing is never "connected".
          connected = read.length > 0 || readings.length === 0;
        }
        if (missing > 0) notes.push(T.status.missing(missing));
        if (notFollowed > 0) notes.push(T.status.notFollowed(notFollowed));
        if (this.projectsError) notes.push(T.status.partial(reasonOf(this.projectsError)));
      }
      if (!this.store.readable && this.store.state !== 'unknown')
        notes.push(T.status.dataUnreadable);
    }
    const message = T.join(notes);
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    if (generation !== this.generation) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${this.describe(err)}`);
    });
  }

  // --- Devices -----------------------------------------------------------------

  /** Discovery: the followed projects (never a reading). */
  async publishDiscovery() {
    if (this.projects === null) return;
    const created = new Map((this.gladys.devices ?? []).map((d) => [d?.external_id, d]));
    const devices = this.projects.followed.map((p) =>
      buildProjectDevice(this.gladys, p, created.get(projectIds(this.gladys, p.id).device)),
    );
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${this.describe(err)}`);
    });
  }

  /** Scan: Discovery from the list known; the list is read again at the next round. */
  async scan() {
    this.projectsWanted = true;
    await this.publishDiscovery();
  }

  /** A device created: its states, only from readings younger than the interval. */
  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) return;
    const reading = this.readings.get(parsed.id);
    if (!reading) return;
    const mono = this.monotonic();
    const fresh = (at) => at !== null && mono - at < this.config.intervalMs;
    await this.publishStates(
      projectStates(this.gladys, parsed.id, {
        issues: fresh(reading.issuesAt) ? reading.issues : null,
        counts: fresh(reading.countsAt) ? reading.counts : null,
      }),
    );
  }

  // --- Configuration button ----------------------------------------------------

  /**
   * One reading of the project list, even after a refused token (the way to
   * lift it), never during a pause Sentry asked for, once a minute at most.
   */
  async testConnection() {
    const problem = configProblem(this.config);
    if (problem) throw new Error(T.problems[problem].en);
    const mono = this.monotonic();
    if (this.pauseUntil !== null && mono < this.pauseUntil)
      return T.status.paused(this.pauseUntil - mono);
    if (this.lastTestAt !== null && mono - this.lastTestAt < TIMINGS.TEST_EVERY_MS) {
      return T.test.tooSoon(Math.ceil((TIMINGS.TEST_EVERY_MS - (mono - this.lastTestAt)) / 1000));
    }
    this.lastTestAt = mono;
    const generation = this.generation;
    let result;
    try {
      result = await this.within(
        this.client.projects(),
        TIMINGS.TEST_BUDGET_MS,
        'No answer in time',
      );
    } catch (err) {
      if (generation === this.generation) {
        if (err?.code === CODES.HTTP && err.status === 401) await this.refuse(generation);
        else if (isPausing(err)) await this.pause(err, generation);
        else if (err instanceof SentryError) this.projectsError = err;
        await this.updateStatus();
      }
      if (err?.code === CODES.HTTP && err.status === 401) {
        throw new Error('Sentry refused the token (HTTP 401).', { cause: err });
      }
      if (err?.code === CODES.HTTP && err.status === 403)
        throw new Error(T.status.forbidden.en, { cause: err });
      if (err?.code === CODES.HTTP && err.status === 404)
        throw new Error(T.status.notFound.en, { cause: err });
      throw new Error(`Sentry not reached (${reasonOf(err).en}).`, { cause: err });
    }
    if (generation !== this.generation) return T.test.ok(result.projects.length);
    const wasRefused = this.refused;
    this.refused = false;
    await this.projectsRead(result, generation);
    if (generation !== this.generation) return T.test.ok(result.projects.length);
    if (wasRefused) this.logger.info('Token accepted again: readings resume');
    await this.updateStatus();
    this.scheduleTick(generation);
    return T.test.ok(result.projects.length);
  }
}
