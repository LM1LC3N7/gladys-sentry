// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// Pure. An invalid entry is only flagged, never kept nor shown back: a token
// pasted in the wrong field must never reach a status or a log.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import {
  LIMITS,
  REFRESH_INTERVALS,
  REGION_ORIGINS,
  REGIONS,
  SLUG_PATTERN,
  SPIKE_THRESHOLD_DEFAULT,
  SPIKE_THRESHOLD_MAX,
  SPIKE_THRESHOLD_MIN,
} from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  region: REGIONS.US,
  refresh_interval: '600',
  spike_threshold: SPIKE_THRESHOLD_DEFAULT,
});

/** What a Sentry auth token may hold: printable ASCII, no space (never CR, LF). */
const TOKEN_PATTERN = /^[\x21-\x7e]{1,512}$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** An IPv4 literal in a private or loopback range (http admitted only there). */
function privateIPv4(host) {
  const parts = host.split('.').map(Number);
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** 0.0.0.0, broadcast, multicast: never a server. */
function unusableIPv4(host) {
  const [a, , , d] = host.split('.').map(Number);
  return a === 0 || (a >= 224 && a <= 239) || a === 255 || d === 255;
}

/**
 * The self-hosted Sentry URL -> { origin, base } (base: origin + path prefix,
 * no trailing slash), or { error: 'missing' | 'invalid' | 'http' }.
 * https always; plain http only to a private or loopback IP address (the token
 * would cross the network in clear: only a LAN the user owns).
 */
export function parseSelfHostedUrl(value) {
  let raw = text(value);
  if (!raw) return { error: 'missing' };
  // eslint-disable-next-line no-control-regex
  if (raw.length > 300 || /[\s\x00-\x1f\x7f]/.test(raw)) return { error: 'invalid' };
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'invalid' };
  if (url.username || url.password || url.search || url.hash) return { error: 'invalid' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { error: 'invalid' };
  const ipVersion = isIP(host);
  if (ipVersion === 4 && unusableIPv4(host)) return { error: 'invalid' };
  if (ipVersion === 6 && (host === '::' || /^ff/i.test(host))) return { error: 'invalid' };
  if (
    ipVersion === 0 &&
    !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host)
  ) {
    return { error: 'invalid' };
  }
  if (url.protocol === 'http:') {
    const lan =
      (ipVersion === 4 && privateIPv4(host)) ||
      (ipVersion === 6 && (host === '::1' || /^f[cd]/i.test(host)));
    if (!lan) return { error: 'http' };
  }
  // The path prefix of a Sentry behind a reverse proxy (`/sentry`); `/api/0`
  // pasted with it is removed (added by the client).
  let path = url.pathname.replace(/\/+$/, '').replace(/\/api\/0$/, '');
  if (!/^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,63}){0,5}$/.test(path) || /\/\.\.?(\/|$)/.test(path)) {
    return { error: 'invalid' };
  }
  return { origin: url.origin, base: `${url.origin}${path}` };
}

/**
 * The projects to follow: slugs separated by commas, semicolons or spaces.
 * Empty: every project of the organization (LIMITS.PROJECTS at most).
 * -> { slugs: [...], invalid: count, tooMany } or null.
 */
export function parseProjectFilter(value) {
  const tokens = text(value)
    .toLowerCase()
    .split(/[,;\s]+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const slugs = [...new Set(tokens.filter((t) => SLUG_PATTERN.test(t)))];
  return {
    slugs: slugs.slice(0, LIMITS.PROJECTS),
    invalid: tokens.filter((t) => !SLUG_PATTERN.test(t)).length,
    tooMany: slugs.length > LIMITS.PROJECTS,
  };
}

/** A strict integer in a range, or the fallback ('' and null are not 0). */
function integerIn(value, min, max, fallback) {
  const raw = typeof value === 'number' ? String(value) : text(value);
  if (!/^\d{1,9}$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= min && n <= max ? n : fallback;
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const token = text(raw.auth_token);
  const region = Object.values(REGIONS).includes(raw.region) ? raw.region : DEFAULTS.region;
  let origin = null;
  let base = null;
  let urlError = null;
  if (region === REGIONS.SELF_HOSTED) {
    const parsed = parseSelfHostedUrl(raw.self_hosted_url);
    if (parsed.error) urlError = parsed.error;
    else ({ origin, base } = parsed);
  } else {
    origin = REGION_ORIGINS[region];
    base = origin;
  }
  const orgRaw = text(raw.organization).toLowerCase();
  const interval = REFRESH_INTERVALS.includes(String(raw.refresh_interval))
    ? String(raw.refresh_interval)
    : DEFAULTS.refresh_interval;
  return {
    token,
    // An invisible character pasted with the token (U+200B, a new line...):
    // said to the user, never sent.
    tokenInvalid: token !== '' && !TOKEN_PATTERN.test(token),
    region,
    origin,
    base,
    urlError,
    organization: SLUG_PATTERN.test(orgRaw) ? orgRaw : null,
    organizationInvalid: orgRaw !== '' && !SLUG_PATTERN.test(orgRaw),
    filter: parseProjectFilter(raw.projects),
    intervalMs: Number(interval) * 1000,
    spikeThreshold: integerIn(
      raw.spike_threshold,
      SPIKE_THRESHOLD_MIN,
      SPIKE_THRESHOLD_MAX,
      DEFAULTS.spike_threshold,
    ),
  };
}

/** What is missing or wrong for a reading, or null when the configuration can be used. */
export function configProblem(config) {
  if (!config.token) return 'token_missing';
  if (config.tokenInvalid) return 'token_invalid';
  if (config.urlError) return `url_${config.urlError}`;
  if (config.organizationInvalid) return 'organization_invalid';
  if (!config.organization) return 'organization_missing';
  return null;
}
