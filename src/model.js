// -----------------------------------------------------------------------------
// Gladys devices and states (pure).
//
//   project  `ext:<selector>:project:<Sentry project id>`, read only:
//            unresolved issues, errors of the last hour, errors of the last
//            24 h, title of the newest unresolved issue
//
// The project id is the one Sentry gives (stable; the slug and the name may
// change). Counters carry no unit (the core lists none for counter-sensor).
// A device republished never loses a feature: the features of the created
// device are kept.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { FEATURES, LIMITS, NO_ISSUE, PROJECT_ID_PATTERN, PROJECT_TYPE } from './constants.js';

export const projectIds = (gladys, projectId) => gladys.externalIds(PROJECT_TYPE, projectId);

const counter = (name) => ({
  name,
  category: C.COUNTER_SENSOR,
  type: T.SENSOR.INTEGER,
  min: 0,
  max: LIMITS.COUNT_MAX,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});

export const SPECS = Object.freeze({
  [FEATURES.UNRESOLVED]: counter('Unresolved issues'),
  [FEATURES.ERRORS_HOUR]: counter('Errors in the last hour'),
  [FEATURES.ERRORS_DAY]: counter('Errors in the last 24 h'),
  [FEATURES.LATEST_ISSUE]: {
    name: 'Newest issue',
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  },
});

export function buildProjectDevice(gladys, project, created) {
  const ids = projectIds(gladys, project.id);
  const keys = Object.keys(SPECS);
  // A feature of the created device this version does not know is kept as it is.
  const extra = (created?.features ?? []).filter(
    (f) =>
      typeof f?.external_id === 'string' && !keys.some((k) => f.external_id === ids.feature(k)),
  );
  const params = [
    { name: 'PROJECT_ID', value: project.id },
    { name: 'PROJECT_SLUG', value: project.slug },
  ];
  if (project.platform) params.push({ name: 'PLATFORM', value: project.platform });
  return {
    name: project.name,
    external_id: ids.device,
    model: 'Sentry project',
    should_poll: false,
    params,
    features: [...keys.map((key) => ({ ...SPECS[key], external_id: ids.feature(key) })), ...extra],
  };
}

/** { id, feature } (feature null for the device) of an external id of this integration, or null. */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  const prefix = gladys.externalId(`${PROJECT_TYPE}:`);
  if (!externalId.startsWith(prefix)) return null;
  const [id, feature, ...rest] = externalId.slice(prefix.length).split(':');
  if (rest.length > 0 || !PROJECT_ID_PATTERN.test(id ?? '')) return null;
  if (feature !== undefined && !/^[a-z_0-9]{1,40}$/.test(feature)) return null;
  return { id, feature: feature ?? null };
}

/**
 * The states of a project reading { issues?, counts? } (an absent part
 * publishes nothing: unknown stays unknown).
 */
export function projectStates(gladys, projectId, reading) {
  const ids = projectIds(gladys, projectId);
  const states = [];
  const { issues, counts } = reading ?? {};
  if (issues) {
    if (issues.total !== null && issues.total <= LIMITS.COUNT_MAX) {
      states.push({
        device_feature_external_id: ids.feature(FEATURES.UNRESOLVED),
        state: issues.total,
      });
    }
    const newest = issues.issues[0];
    // The newest issue only when the list is known complete at its head
    // (sorted newest first): an empty list says "none".
    states.push({
      device_feature_external_id: ids.feature(FEATURES.LATEST_ISSUE),
      text: newest ? newest.title || newest.shortId || NO_ISSUE : NO_ISSUE,
    });
  }
  if (counts) {
    states.push(
      { device_feature_external_id: ids.feature(FEATURES.ERRORS_HOUR), state: counts.lastHour },
      { device_feature_external_id: ids.feature(FEATURES.ERRORS_DAY), state: counts.day },
    );
  }
  return states;
}
