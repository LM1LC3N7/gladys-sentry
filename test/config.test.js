import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  configProblem,
  normalizeConfig,
  parseProjectFilter,
  parseSelfHostedUrl,
} from '../src/config.js';

test('regions: sentry.io US and EU origins fixed, never configurable', () => {
  assert.equal(normalizeConfig({ region: 'us' }).base, 'https://sentry.io');
  assert.equal(normalizeConfig({ region: 'eu' }).base, 'https://de.sentry.io');
  assert.equal(normalizeConfig({ region: 'mars' }).base, 'https://sentry.io');
  assert.equal(
    normalizeConfig({ region: 'eu', self_hosted_url: 'https://evil.example' }).base,
    'https://de.sentry.io',
  );
  assert.equal(normalizeConfig({}).region, DEFAULTS.region);
});

test('self-hosted URL: https, or http to a private IP only; path prefix kept, /api/0 removed', () => {
  assert.deepEqual(parseSelfHostedUrl('sentry.example.com'), {
    origin: 'https://sentry.example.com',
    base: 'https://sentry.example.com',
  });
  assert.deepEqual(parseSelfHostedUrl('https://example.com:8443/sentry/api/0/'), {
    origin: 'https://example.com:8443',
    base: 'https://example.com:8443/sentry',
  });
  assert.equal(parseSelfHostedUrl('http://192.168.1.5:9000').base, 'http://192.168.1.5:9000');
  assert.equal(parseSelfHostedUrl('http://10.1.2.3').base, 'http://10.1.2.3');
  assert.equal(parseSelfHostedUrl('http://172.16.0.4').base, 'http://172.16.0.4');
  assert.equal(parseSelfHostedUrl('http://[fd00::5]:9000').base, 'http://[fd00::5]:9000');
  // Dot segments are resolved by the URL parser: never a path out of the prefix.
  assert.equal(parseSelfHostedUrl('https://s.example.com/a/../b').base, 'https://s.example.com/b');
  assert.equal(
    parseSelfHostedUrl('https://s.example.com/%2e%2e/x').base,
    'https://s.example.com/x',
  );
  for (const [value, error] of [
    ['', 'missing'],
    ['http://sentry.example.com', 'http'],
    ['http://8.8.8.8', 'http'],
    ['http://172.32.0.1', 'http'],
    ['https://user:pass@sentry.example.com', 'invalid'],
    ['https://sentry.example.com/?token=x', 'invalid'],
    ['https://sentry.example.com/#x', 'invalid'],
    ['ftp://sentry.example.com', 'invalid'],
    ['https://0.0.0.0', 'invalid'],
    ['https://224.0.0.1', 'invalid'],
    ['https://192.168.1.255', 'invalid'],
    ['https://[ff02::1]', 'invalid'],
    ['https://exa mple.com', 'invalid'],
    ['https://sentry.example.com\r\nX: y', 'invalid'],
    ['https://under_score.example.com', 'invalid'],
  ]) {
    assert.deepEqual(parseSelfHostedUrl(value), { error }, value);
  }
});

test('token: trimmed; a space, an invisible character or a new line is flagged, never kept for sending', () => {
  assert.equal(normalizeConfig({ auth_token: '  sntryu_abc  ' }).token, 'sntryu_abc');
  for (const bad of ['abc def', 'abc​def', 'abc\ndef', 'é', 'x'.repeat(513)]) {
    const config = normalizeConfig({ auth_token: bad, organization: 'acme' });
    assert.equal(config.tokenInvalid, true, JSON.stringify(bad));
    assert.equal(configProblem(config), 'token_invalid');
  }
  assert.equal(configProblem(normalizeConfig({ organization: 'acme' })), 'token_missing');
});

test('organization: a slug (lowercased), never a path', () => {
  assert.equal(normalizeConfig({ organization: ' Acme-Corp ' }).organization, 'acme-corp');
  for (const bad of ['acme/../x', 'acme.corp', 'acme:1', '-acme', 'a'.repeat(51)]) {
    const config = normalizeConfig({ auth_token: 'x', organization: bad });
    assert.equal(config.organization, null, bad);
    assert.equal(configProblem(config), 'organization_invalid');
  }
  assert.equal(configProblem(normalizeConfig({ auth_token: 'x' })), 'organization_missing');
  assert.equal(
    configProblem(
      normalizeConfig({ auth_token: 'x', organization: 'acme', region: 'self_hosted' }),
    ),
    'url_missing',
  );
  assert.equal(configProblem(normalizeConfig({ auth_token: 'x', organization: 'acme' })), null);
});

test('project filter: slugs, 20 at most, invalid ones only counted', () => {
  assert.equal(parseProjectFilter(''), null);
  assert.deepEqual(parseProjectFilter('Web, api;api  cron'), {
    slugs: ['web', 'api', 'cron'],
    invalid: 0,
    tooMany: false,
  });
  const many = parseProjectFilter(Array.from({ length: 25 }, (_, i) => `p${i}`).join(','));
  assert.equal(many.slugs.length, 20);
  assert.equal(many.tooMany, true);
  assert.equal(parseProjectFilter('a/b, ../x, ok').invalid, 2);
});

test('interval and threshold: listed values only; the threshold a strict integer in range', () => {
  assert.equal(normalizeConfig({}).intervalMs, 600_000);
  assert.equal(normalizeConfig({ refresh_interval: '300' }).intervalMs, 300_000);
  assert.equal(normalizeConfig({ refresh_interval: '60' }).intervalMs, 600_000);
  assert.equal(normalizeConfig({}).spikeThreshold, 100);
  assert.equal(normalizeConfig({ spike_threshold: 250 }).spikeThreshold, 250);
  assert.equal(normalizeConfig({ spike_threshold: '250' }).spikeThreshold, 250);
  for (const bad of ['', null, 0, 5, 12.5, '1e3', 2_000_000, -50, 'abc']) {
    assert.equal(normalizeConfig({ spike_threshold: bad }).spikeThreshold, 100, String(bad));
  }
});
