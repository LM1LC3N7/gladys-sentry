// -----------------------------------------------------------------------------
// A small JSON file in the writable /data volume, for what must survive a
// restart:
//   attempt      wall clock ms of the last round, written BEFORE its first
//                request: a restart (a crash loop, a reconnection to Gladys,
//                the configuration saved unchanged) never reads sooner than
//                the interval
//   pausedUntil  wall clock ms, the end of a pause Sentry asked for (429, 5xx)
//   refused      { mark, salt }: 8 bits of an HMAC (keyed with a random salt)
//                of the token Sentry refused (HTTP 401), with its origin and
//                organization. A restart with the same configuration does not
//                send it again. Only 8 bits: the mark cannot help guess a
//                token; it is erased by a success.
//   scope        the API base and organization the references belong to
//   refs         per project: { since, ids } the reference of the new issue
//                trigger (no secret: Sentry ids and a date)
// The token itself is never written here.
//
// /data unreadable (EACCES, EIO, a read that hangs) is not "empty": nothing is
// known, the caller waits a whole interval, the file is read again every 10 s
// (one read at a time, each bounded) and never written over until read. A file
// that is not JSON is replaced by the next write: it holds nothing that cannot
// be learned again.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LIMITS, PROJECT_ID_PATTERN } from './constants.js';

export const STORE_STATES = Object.freeze({
  UNKNOWN: 'unknown',
  OK: 'ok',
  UNREADABLE: 'unreadable',
  CORRUPT: 'corrupt',
});

const positive = (v) =>
  Number.isFinite(v) && v > 0 && v < Number.MAX_SAFE_INTEGER ? Math.round(v) : null;

function readRefs(raw) {
  const refs = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refs;
  for (const [id, ref] of Object.entries(raw).slice(0, LIMITS.PROJECTS * 5)) {
    if (!PROJECT_ID_PATTERN.test(id)) continue;
    const since = positive(ref?.since);
    const ids = Array.isArray(ref?.ids)
      ? ref.ids
          .filter((x) => typeof x === 'string' && /^\d{1,20}$/.test(x))
          .slice(0, LIMITS.SEEN_IDS)
      : null;
    if (since !== null && ids) refs[id] = { since, ids };
  }
  return refs;
}

function readContent(parsed) {
  const refused = parsed?.refused;
  return {
    attempt: positive(parsed?.attempt),
    pausedUntil: positive(parsed?.pausedUntil),
    refused:
      refused && /^[0-9a-f]{2}$/.test(refused.mark) && /^[0-9a-f]{64}$/.test(refused.salt)
        ? { mark: refused.mark, salt: refused.salt }
        : null,
    scope: typeof parsed?.scope === 'string' && parsed.scope.length <= 400 ? parsed.scope : null,
    refs: readRefs(parsed?.refs),
  };
}

const EMPTY = () => ({ attempt: null, pausedUntil: null, refused: null, scope: null, refs: {} });

export class Store {
  #writes = Promise.resolve();
  #reading = null;

  /**
   * @param {{ filePath: string, logger?: object, readTimeoutMs?: number,
   *   timers?: { setTimeout: Function, clearTimeout: Function }, fs?: object }} options
   */
  constructor({ filePath, logger, readTimeoutMs = 2_000, timers = globalThis, fs }) {
    this.filePath = filePath;
    this.logger = logger;
    this.readTimeoutMs = readTimeoutMs;
    this.timers = timers;
    this.fs = { readFile, writeFile, rename, rm, mkdir, ...fs };
    this.data = EMPTY();
    this.state = STORE_STATES.UNKNOWN;
  }

  get readable() {
    return this.state === STORE_STATES.OK || this.state === STORE_STATES.CORRUPT;
  }

  /** Reads the file (one read at a time, bounded); resolves the new state. */
  load() {
    if (this.#reading) return this.#reading;
    let handle;
    const read = this.fs.readFile(this.filePath, 'utf8').then(
      (content) => {
        try {
          return { state: STORE_STATES.OK, data: readContent(JSON.parse(content)) };
        } catch {
          return { state: STORE_STATES.CORRUPT, data: EMPTY() };
        }
      },
      (err) =>
        err?.code === 'ENOENT'
          ? { state: STORE_STATES.OK, data: EMPTY() }
          : { state: STORE_STATES.UNREADABLE, code: String(err?.code ?? '') },
    );
    const limit = new Promise((resolve) => {
      handle = this.timers.setTimeout(
        () => resolve({ state: STORE_STATES.UNREADABLE, code: 'TIMEOUT' }),
        this.readTimeoutMs,
      );
    });
    // The read that hangs keeps the slot until it settles: never two at once.
    read.finally(() => {
      this.timers.clearTimeout(handle);
      this.#reading = null;
    });
    const result = Promise.race([read, limit]).then((outcome) => {
      if (outcome.state === STORE_STATES.UNREADABLE) {
        if (this.state !== STORE_STATES.UNREADABLE) {
          this.logger?.warn(
            `/data unreadable (${outcome.code || 'error'}): read again in a moment`,
          );
        }
        this.state = STORE_STATES.UNREADABLE;
        return this.state;
      }
      if (outcome.state === STORE_STATES.CORRUPT && this.state !== STORE_STATES.CORRUPT) {
        this.logger?.warn('/data file is not JSON: replaced at the next write');
      }
      if (this.state !== STORE_STATES.OK && this.state !== STORE_STATES.CORRUPT) {
        // First successful read: the file, merged with what this run learned
        // (the later attempt, the later pause; a refusal learned now stays).
        const mine = this.data;
        const file = outcome.data;
        this.data = {
          attempt: Math.max(mine.attempt ?? 0, file.attempt ?? 0) || null,
          pausedUntil: Math.max(mine.pausedUntil ?? 0, file.pausedUntil ?? 0) || null,
          refused: mine.refused ?? file.refused,
          scope: mine.scope ?? file.scope,
          refs: { ...file.refs, ...mine.refs },
        };
      }
      this.state = outcome.state;
      return this.state;
    });
    this.#reading = result;
    return result;
  }

  get(key) {
    return this.data[key];
  }

  /**
   * Sets values, then writes the file. Resolves true when written; false when
   * /data is unreadable (not written over) or the write failed (kept in memory).
   */
  async update(values) {
    Object.assign(this.data, values);
    if (!this.readable) return false;
    return this.#save();
  }

  /** Resolves when the writes queued so far are done (or failed). */
  flushed() {
    return this.#writes;
  }

  #save() {
    const write = this.#writes.then(() => this.#write());
    this.#writes = write.catch(() => {});
    return write;
  }

  async #write() {
    const tmp = `${this.filePath}.tmp`;
    try {
      await this.fs.mkdir(dirname(this.filePath), { recursive: true });
      await this.fs.writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await this.fs.rename(tmp, this.filePath);
      return true;
    } catch (err) {
      await this.fs.rm(tmp, { force: true }).catch(() => {});
      this.logger?.warn(`/data not written (${String(err?.code ?? 'error')}): kept in memory`);
      return false;
    }
  }
}
