// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS } from '../src/config.js';
import {
  ACTIONS,
  REFRESH_INTERVALS,
  REGIONS,
  SCENE_TRIGGERS,
  SPIKE_THRESHOLD_MAX,
  SPIKE_THRESHOLD_MIN,
  VERSION,
} from '../src/constants.js';
import { buildProjectDevice } from '../src/model.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
const gladys = createFakeGladys({ selector: 'sentry' });
const device = buildProjectDevice(gladys, { id: '1', slug: 'web', name: 'Web', platform: 'node' });
const features = device.features;

test('the store basics; version 0.1.0 set by hand everywhere, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0', 'scene triggers need 5.1');
  assert.equal(manifest.countries, undefined, 'sentry.io and self-hosted: every country');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(VERSION, manifest.version, 'the User-Agent version');
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-sentry:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-sentry');
  assert.equal(lock.name, 'gladys-sentry');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\.1$/);
  assert.match(pkg.scripts.test, /--test-timeout=60000/);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['servers']);
  assert.equal(manifest.keywords, undefined);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated with Sentry/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien avec Sentry/);
  assert.match(read('docs/en.md'), /never been tested with a real Sentry/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai Sentry/i);
});

test('the license (standard, no name) and the notices ship in the image', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /No third-party code/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /Functional Source License/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual; no "encrypted"', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
  assert.doesNotMatch(JSON.stringify(manifest), /chiffr|encrypt|hachage|hash/i);
});

test('the configuration matches the code; the token a secret without default; no key prefixed gladys_', () => {
  for (const [key, value] of Object.entries(DEFAULTS))
    assert.equal(fields[key].default, value, key);
  assert.deepEqual(
    fields.refresh_interval.options.map((o) => o.value),
    REFRESH_INTERVALS,
  );
  assert.deepEqual(
    fields.region.options.map((o) => o.value),
    Object.values(REGIONS),
  );
  assert.equal(fields.spike_threshold.min, SPIKE_THRESHOLD_MIN);
  assert.equal(fields.spike_threshold.max, SPIKE_THRESHOLD_MAX);
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'auth_token',
    'region',
    'self_hosted_url',
    'organization',
    'projects',
    'refresh_interval',
    'spike_threshold',
  ]);
  for (const field of manifest.config_schema) assert.doesNotMatch(field.key, /^gladys_/);
  assert.equal(fields.auth_token.type, 'secret');
  assert.equal(fields.auth_token.default, undefined);
  assert.match(
    fields.auth_token.description.en,
    /Kept by Gladys in its database, never shown again, sent only to/,
  );
  assert.match(
    fields.auth_token.description.fr,
    /Gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement/,
  );
  // Examples: never an id, never a real token.
  assert.doesNotMatch(JSON.stringify(manifest), /sntryu_[A-Za-z0-9]{8,}/);
});

test('sections store nothing; links https', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
    for (const text of Object.values(section.description)) assert.ok(text.length <= 1000);
  }
});

test('actions, scene triggers and handlers: the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS))
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.deepEqual(keys(manifest.scene_triggers).sort(), Object.values(SCENE_TRIGGERS).sort());
  for (const name of Object.keys(SCENE_TRIGGERS)) {
    assert.ok(app.includes(`SCENE_TRIGGERS.${name}`), `${name} fired by the app`);
  }
  for (const trigger of manifest.scene_triggers) {
    assert.ok(trigger.fields.length <= 10 && trigger.variables.length <= 20);
    for (const field of trigger.fields) {
      assert.ok(['string', 'number', 'select', 'multi_select'].includes(field.type));
      assert.equal(field.required, false, 'empty: any');
    }
  }
  for (const absent of ['scene_actions', 'widgets', 'music'])
    assert.equal(manifest[absent], undefined, absent);
  for (const handler of ['onScanRequest(', 'onConfigUpdated(', 'onDeviceCreated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('scene event data: every declared key, flat, null never undefined (src/app.js)', () => {
  for (const trigger of manifest.scene_triggers) {
    for (const key of [...keys(trigger.fields), ...keys(trigger.variables)]) {
      assert.match(app, new RegExp(`\\b${key}:`), `${trigger.key}.${key} sent by the app`);
    }
  }
});

test('features: every NOT NULL column; read only; no switch, no binary', () => {
  assert.equal(features.length, 4);
  for (const f of features) {
    for (const column of [
      'name',
      'min',
      'max',
      'read_only',
      'has_feedback',
      'category',
      'type',
      'external_id',
    ]) {
      assert.ok(f[column] !== undefined && f[column] !== null, `${f.external_id} ${column}`);
    }
    assert.equal(f.read_only, true);
    assert.ok(!['switch', 'light', 'lock', 'button'].includes(f.category), f.external_id);
    assert.equal(f.unit, undefined, 'counter-sensor and text: no unit in the core list');
    assert.doesNotMatch(f.external_id.split(':').slice(2).join(':'), /\./);
  }
});

test('supported_options: none published (the rules of the core would apply to any)', () => {
  const core = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
  const normalize = existsSync(core)
    ? createRequire(import.meta.url)(core).normalizeSupportedOptions
    : null;
  for (const f of features) {
    if (f.supported_options === undefined) continue;
    for (const option of f.supported_options) {
      assert.equal(typeof option.label, 'string');
      assert.ok(option.label.length > 0 && option.label === option.label.trim());
    }
    if (normalize)
      assert.deepEqual(
        normalize(f.supported_options, { allowStringValues: true }),
        f.supported_options,
      );
  }
  assert.equal(features.filter((f) => f.supported_options !== undefined).length, 0);
});
