// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys, the external id shapes and the
// feature keys are stored in user devices and scenes: never rename them
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const VERSION = '0.1.0';
export const USER_AGENT = `gladys-sentry/${VERSION} (+https://github.com/LM1LC3N7/gladys-sentry)`;

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

export const SCENE_TRIGGERS = Object.freeze({
  NEW_ISSUE: 'new_issue',
  ERROR_SPIKE: 'error_spike',
});

/** Device external ids: `ext:<selector>:project:<Sentry project id>`. */
export const PROJECT_TYPE = 'project';

/** A Sentry project id: digits only (the API gives it as a string). */
export const PROJECT_ID_PATTERN = /^[0-9]{1,20}$/;

/** An organization or project slug (lowercase letters, digits, - and _). */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/;

/** The features of a project device. */
export const FEATURES = Object.freeze({
  UNRESOLVED: 'unresolved_issues',
  ERRORS_HOUR: 'errors_last_hour',
  ERRORS_DAY: 'errors_24h',
  LATEST_ISSUE: 'latest_issue',
});

/** The text of "Latest issue" when no issue is unresolved. */
export const NO_ISSUE = '-';

/** The region of a sentry.io organization, or a self-hosted Sentry. */
export const REGIONS = Object.freeze({
  US: 'us',
  EU: 'eu',
  SELF_HOSTED: 'self_hosted',
});

/** The API origins of sentry.io (data storage location documentation). */
export const REGION_ORIGINS = Object.freeze({
  us: 'https://sentry.io',
  eu: 'https://de.sentry.io',
});

/** Seconds between two rounds; 600 (10 min) is the default. */
export const REFRESH_INTERVALS = Object.freeze(['300', '600', '900', '1800', '3600']);

export const LIMITS = Object.freeze({
  /** Projects followed at most (two requests each per round). */
  PROJECTS: 20,
  /** Project pages read at most (100 projects each, the API maximum). */
  PROJECT_PAGES: 3,
  PROJECT_PAGE: 100,
  /** Unresolved issues read per project and round (newest first, the API maximum). */
  ISSUES: 100,
  /** Issue ids remembered per project (new issue detection). */
  SEEN_IDS: 200,
  /** New issue events per project and per round; the rest is only logged. */
  EVENTS_PER_PROJECT: 5,
  /** Scene events per round, every project together. */
  EVENTS_PER_ROUND: 30,
  /** POST /state admits 300 states per minute per integration: kept under 250. */
  STATES_PER_MINUTE: 250,
  /** Texts kept (issue title, culprit, project name). */
  TITLE: 200,
  NAME: 100,
  /** Highest count published (a counter beyond is not a reading). */
  COUNT_MAX: 1_000_000_000,
  /** Requests of one round at most: the project list, then two per project. */
  REQUESTS_PER_ROUND: 3 + 2 * 20,
});

/** Error spike: the last hour at least this many times the usual hour. */
export const SPIKE_FACTOR = 3;
/** Default threshold (errors in the last hour) of the configuration. */
export const SPIKE_THRESHOLD_DEFAULT = 100;
export const SPIKE_THRESHOLD_MIN = 10;
export const SPIKE_THRESHOLD_MAX = 1_000_000;

/** A new issue older than this (Sentry's own clock) is not "new" any more. */
export const NEW_ISSUE_MAX_AGE_MS = 2 * 3600_000;
/** An event may reach Sentry late: an issue first seen this long before the reference is still new. */
export const LATE_ARRIVAL_MS = 3600_000;

/** Size caps of an answer (a page of 100 projects is the largest). */
export const MAX_BYTES = Object.freeze({
  PROJECTS: 2 * 1024 * 1024,
  ISSUES: 1024 * 1024,
  STATS: 256 * 1024,
});

export const TIMINGS = Object.freeze({
  /** One request, the whole exchange. */
  REQUEST_MS: 15_000,
  /** The project list is read again this often (and on a Scan, never faster than a round). */
  PROJECTS_EVERY_MS: 3600_000,
  /** Failures retry at the round interval at least, doubling up to this. */
  RETRY_MAX_MS: 3600_000,
  /** HTTP 429 and 5xx: pause of every request, within these bounds. */
  PAUSE_MIN_MS: 60_000,
  PAUSE_MAX_MS: 6 * 3600_000,
  /** Sentry says no request is left in its window: waited for in the round, up to this. */
  WINDOW_WAIT_MAX_MS: 10_000,
  /** getConfig() failing: asked again after this. */
  CONFIG_RETRY_MS: 30_000,
  /** /data unreadable: read again after this; one read bounded to DATA_READ_MS. */
  DATA_RETRY_MS: 10_000,
  DATA_READ_MS: 2_000,
  /** The test button sends at most one request in this time. */
  TEST_EVERY_MS: 60_000,
  /** Gladys waits for the answer of the button 30 s (manifest). */
  TEST_BUDGET_MS: 25_000,
  /** A reading older than this many intervals is a gap: triggers only take it as reference. */
  GAP_INTERVALS: 2,
});

/** Longest delay ever given to a timer (Node fires a larger one at once). */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** The persistent store (see src/store.js). */
export const STORE_FILE = 'sentry.json';
