// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, and never
// mojibake (UTF-8 read as Latin-1 / Windows-1252 and saved again), nor carry
// control characters other than new lines.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const MOJIBAKE = /Ã|Â|â€|Å[’“]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const sources = (dir) =>
  readdirSync(new URL(`../${dir}`, import.meta.url), { recursive: true })
    .map((name) => `${dir}/${String(name).replace(/\\/g, '/')}`)
    .filter((name) => name.endsWith('.js'));

const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'index.js',
  ...sources('src'),
];

test('the list covers every source file', () => {
  assert.ok(FILES.includes('src/app.js'));
  assert.ok(FILES.includes('src/sentry/http.js'));
});

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake, no control character`, () => {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l) || CONTROL.test(l));
    assert.equal(line, -1, `mojibake or control character on line ${line + 1}`);
    if (file !== 'TODO.md' && file !== 'CLAUDE.md') {
      assert.doesNotMatch(text, /chiffré|encrypted/i, '"encrypted": nothing here is');
    }
  });
}

test('the patterns catch what they should', () => {
  assert.match('FranÃ§ais', MOJIBAKE);
  assert.match('lâ€™app', MOJIBAKE);
  assert.match('Å“uvre', MOJIBAKE);
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app… Œuvre', MOJIBAKE);
  assert.match('a\u0007b', CONTROL);
  assert.doesNotMatch('a\tb\r\n', CONTROL);
});
