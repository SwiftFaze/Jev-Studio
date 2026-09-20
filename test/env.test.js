import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadDotEnv } from '../src/env.js';

const tempFile = (contents) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'jev-env-')), '.env');
  writeFileSync(file, contents);
  return file;
};

test('values in .env override variables already in the environment', () => {
  const env = { TYPESAFE_API_KEY: 'from-system', OTHER: 'keep' };
  const keys = loadDotEnv(tempFile('TYPESAFE_API_KEY=from-file\nPORT=4000\n'), env);
  assert.equal(env.TYPESAFE_API_KEY, 'from-file');
  assert.equal(env.PORT, '4000');
  assert.equal(env.OTHER, 'keep');
  assert.deepEqual(keys.sort(), ['PORT', 'TYPESAFE_API_KEY']);
});

test('an empty value in .env still wins, so the system key is not used silently', () => {
  const env = { TYPESAFE_API_KEY: 'from-system' };
  const keys = loadDotEnv(tempFile('TYPESAFE_API_KEY=\n'), env);
  assert.equal(env.TYPESAFE_API_KEY, '');
  assert.deepEqual(keys, ['TYPESAFE_API_KEY']);
});

test('a missing .env leaves the environment untouched', () => {
  const env = { TYPESAFE_API_KEY: 'from-system' };
  const keys = loadDotEnv(path.join(tmpdir(), 'jev-does-not-exist', '.env'), env);
  assert.deepEqual(keys, []);
  assert.equal(env.TYPESAFE_API_KEY, 'from-system');
});

test('ignores comments and handles quoted values', () => {
  const env = {};
  loadDotEnv(tempFile('# comment\nTYPESAFE_API_KEY="quoted-key"\n'), env);
  assert.equal(env.TYPESAFE_API_KEY, 'quoted-key');
});
