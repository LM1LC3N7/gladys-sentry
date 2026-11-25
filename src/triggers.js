// -----------------------------------------------------------------------------
// The two scene triggers, decided on readings (pure).
//
// New issue: an unresolved issue whose id was not in the previous reading of
// its project, first seen after the reference (minus an hour: an event may
// reach Sentry late) and less than 2 h ago by Sentry's own clock (the `Date`
// header). The first reading of a project only sets the reference, which is
// kept in /data: a restart neither repeats nor loses an issue.
//
// Error spike: the errors of the last hour (the current hour so far, plus the
// share of the previous hour still inside the last 60 minutes) reach the
// threshold of the configuration AND three times the usual hour (the mean of
// the 22 complete hours before). Once fired, armed again only after the last
// hour went under half the threshold. The first reading (or one after a
// gap) only takes the state as it is: never an event.
// -----------------------------------------------------------------------------

import { LATE_ARRIVAL_MS, LIMITS, NEW_ISSUE_MAX_AGE_MS, SPIKE_FACTOR } from './constants.js';

const HOUR = 3600_000;

/**
 * @param {{ since: number, ids: string[] } | null} ref the reference of the project
 * @param {Array} issues the unresolved issues read, newest first
 * @param {number|null} serverNow Sentry's clock (Date header) or null
 * -> { fresh: [issues to announce, newest first], ref }
 */
export function detectNewIssues(ref, issues, serverNow) {
  const firstSeens = issues.map((i) => i.firstSeen).filter((v) => v !== null);
  const newest = firstSeens.length > 0 ? Math.max(...firstSeens) : null;
  const pageIds = issues.map((i) => i.id);
  if (!ref) {
    const since = newest ?? serverNow;
    return {
      fresh: [],
      ref: since === null ? null : { since, ids: pageIds.slice(0, LIMITS.SEEN_IDS) },
    };
  }
  const seen = new Set(ref.ids);
  const fresh = issues.filter(
    (issue) =>
      !seen.has(issue.id) &&
      issue.firstSeen !== null &&
      issue.firstSeen > ref.since - LATE_ARRIVAL_MS &&
      // Without Sentry's clock, the age is unknown: the reference alone decides.
      (serverNow === null || serverNow - issue.firstSeen <= NEW_ISSUE_MAX_AGE_MS),
  );
  const ids = [...new Set([...pageIds, ...ref.ids])].slice(0, LIMITS.SEEN_IDS);
  return { fresh, ref: { since: Math.max(ref.since, newest ?? ref.since), ids } };
}

/**
 * The errors of a stats reading: { lastHour, day, usual } (integers).
 * `at`: the end of the reading (the `end` of the answer, else the Date header).
 */
export function errorCounts(stats, at) {
  const { counts, lastStart } = stats;
  const current = counts.at(-1);
  const previous = counts.at(-2);
  // Without the end of the reading, only the current hour (never more).
  const elapsed = at === null ? 1 : Math.min(1, Math.max(0, (at - lastStart) / HOUR));
  const lastHour = Math.round(current + previous * (1 - elapsed));
  const day = counts.reduce((sum, n) => sum + n, 0);
  const older = counts.slice(0, -2);
  const usual = older.length > 0 ? older.reduce((sum, n) => sum + n, 0) / older.length : 0;
  return { lastHour, day, usual: Math.round(usual * 10) / 10 };
}

/** True when the counts make a spike for this threshold. */
export const isSpike = ({ lastHour, usual }, threshold) =>
  lastHour >= threshold && lastHour >= SPIKE_FACTOR * usual;

/**
 * @param {boolean|null} active the spike state of the previous reading (null: none, or a gap)
 * -> { fire, active }
 */
export function detectSpike(active, counts, threshold) {
  const spike = isSpike(counts, threshold);
  if (active === null) return { fire: false, active: spike };
  if (active) return { fire: false, active: counts.lastHour >= threshold / 2 };
  return { fire: spike, active: spike };
}
