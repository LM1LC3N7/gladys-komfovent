// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The version is
// never pinned (the Release workflow bumps it): only its shape and agreement.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS, MODES, POLL_INTERVAL, UNIT_ID } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/);
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-komfovent');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-komfovent:${manifest.version}`);
  assert.deepEqual(manifest.transports, ['local']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Komfovent|sans\s+lien\s+avec\s+Komfovent/i);
    assert.match(
      docs,
      /never\s+tested\s+with\s+a\s+real\s+device|jamais\s+testé\s+avec\s+un\s+vrai\s+appareil/i,
      'say it was never tested',
    );
    assert.match(
      docs,
      /trusted\s+network|réseau\s+de\s+confiance/i,
      'say Modbus TCP has no password',
    );
  }
  assert.match(manifest.config_schema[0].description.fr, /Jamais testé avec un vrai appareil/);
  assert.match(manifest.config_schema[0].description.en, /Never tested with a real device/);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('no secret, no capture, no sub-container, no scene or widget', () => {
  assert.ok(manifest.config_schema.every((f) => f.type !== 'secret'));
  // Never a default on a secret field (the store validator refuses it), should one be added.
  assert.ok(manifest.config_schema.every((f) => f.type !== 'secret' || !('default' in f)));
  for (const key of [
    'network_discovery',
    'network_wake',
    'containers',
    'scene_actions',
    'scene_triggers',
    'widgets',
  ]) {
    assert.equal(manifest[key], undefined, key);
  }
});

test('the configuration matches the code; the commands are off by default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  assert.equal(fields.unit_id.type, 'number');
  assert.deepEqual([fields.unit_id.min, fields.unit_id.max], [UNIT_ID.min, UNIT_ID.max]);
  assert.equal(fields.unit_id.default, UNIT_ID.default);
  assert.equal(fields.allow_commands.type, 'boolean');
  assert.equal(fields.allow_commands.default, false);
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max, fields.poll_interval.default],
    [POLL_INTERVAL.min, POLL_INTERVAL.max, POLL_INTERVAL.default],
  );
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the actions are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
});

test('the select options: string labels in both languages, the four modes only', () => {
  const gladys = createFakeGladys();
  for (const language of ['en', 'fr']) {
    const device = buildDevice(gladys, { language });
    const select = device.features.find((f) => f.type === 'select');
    assert.deepEqual(
      select.supported_options.map((o) => o.value),
      MODES,
    );
    for (const option of select.supported_options) {
      assert.equal(typeof option.label, 'string', `${option.value}: label is a string`);
      assert.ok(option.label.length > 0);
    }
  }
});

test('the manifest names no app and asks for nothing beyond the local network', () => {
  const text = JSON.stringify(manifest);
  assert.doesNotMatch(text, /user[-_ ]?agent|firmware update|mise à jour du micrologiciel/i);
  assert.ok(!manifest.config_schema.some((f) => f.key.startsWith('gladys_')), 'no gladys_ key');
  assert.ok(Array.isArray(manifest.categories) && manifest.categories.length >= 1);
  assert.ok(manifest.categories.length <= 3);
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
});
