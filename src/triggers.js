// -----------------------------------------------------------------------------
// The two scene triggers, decided on readings (pure).
//
// New issue: an unresolved issue whose id was never seen in the readings of
// its project (the 100 newest each time, 200 ids remembered), first seen
// after the previous reading by Sentry's clock (minus an hour: an event may
// reach Sentry late) and less than 2 h ago by Sentry's own clock (the `Date`
// header). The first reading of a project only sets the reference, which is
// kept in /data: a restart neither repeats nor loses an issue.
//
// Error spike: the errors of the last hour (the current hour so far, plus the
// share of the previous hour still inside the last 60 minutes) reach the
// threshold of the configuration AND three times the usual hour (the mean of
// the complete hours before the last two, 22 at most). Once fired, armed again only after the last
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
  // The time of this reading: Sentry's clock, else the newest issue.
  const readAt = serverNow ?? newest;
  if (!ref) {
    return {
      fresh: [],
      ref: readAt === null ? null : { since: readAt, ids: pageIds.slice(0, LIMITS.SEEN_IDS) },
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
  return { fresh, ref: { since: Math.max(ref.since, readAt ?? ref.since), ids } };
}

/**
 * The errors of a stats reading: { lastHour, day, usual }.
 * `at`: the time of the reading by Sentry's clock (the `Date` header of the
 * answer; never the `end` of stats_v2, which Sentry rounds up to the next
 * hour). The last bucket is the current hour, partial: the last 60 minutes
 * are that bucket plus the share of the previous one still inside them; the
 * last 24 h likewise over 25 buckets. The usual hour is the mean of the
 * complete hours before the last two (22 at most).
 */
export function errorCounts(stats, at) {
  const { counts, lastStart } = stats;
  // Without the time of the reading, only the current hour (never more).
  const elapsed = at === null ? 1 : Math.min(1, Math.max(0, (at - lastStart) / HOUR));
  const window = (hours) => {
    const whole = counts.slice(-hours).reduce((sum, n) => sum + n, 0);
    const share = counts.length > hours ? counts.at(-hours - 1) * (1 - elapsed) : 0;
    return Math.round(whole + share);
  };
  const older = counts.slice(-24, -2);
  const usual = older.length > 0 ? older.reduce((sum, n) => sum + n, 0) / older.length : 0;
  return { lastHour: window(1), day: window(24), usual: Math.round(usual * 10) / 10 };
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
