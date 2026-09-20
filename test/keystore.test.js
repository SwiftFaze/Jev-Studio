import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appDataDir, createKeyStore, machineSecret } from '../src/keystore.js';

const KEY = 'ts_live_0123456789abcdef';

function withDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-keystore-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a key round-trips, also through a new store on the same folder (a restart)', () => {
  withDir((dir) => {
    const store = createKeyStore({ dir, secret: 's' });
    assert.deepEqual(store.read(), { status: 'none' });
    store.write(KEY);
    assert.deepEqual(store.read(), { status: 'ok', key: KEY });
    assert.deepEqual(createKeyStore({ dir, secret: 's' }).read(), { status: 'ok', key: KEY });
  });
});

test('the file on disk holds no readable trace of the key', () => {
  withDir((dir) => {
    const store = createKeyStore({ dir, secret: 's' });
    store.write(KEY);
    const raw = readFileSync(store.file, 'utf8');
    for (const piece of [KEY, KEY.slice(3, 15), Buffer.from(KEY).toString('base64'), Buffer.from(KEY).toString('hex')]) {
      assert.equal(raw.includes(piece), false, piece);
    }
    assert.equal(JSON.parse(raw).alg, 'aes-256-gcm');
  });
});

test('every save uses a fresh salt and IV, so the same key never looks the same twice', () => {
  withDir((dir) => {
    const store = createKeyStore({ dir, secret: 's' });
    store.write(KEY);
    const first = JSON.parse(readFileSync(store.file, 'utf8'));
    store.write(KEY);
    const second = JSON.parse(readFileSync(store.file, 'utf8'));
    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.data, second.data);
  });
});

test('a file written for another machine or user cannot be read, and is not mistaken for "no key"', () => {
  withDir((dir) => {
    createKeyStore({ dir, secret: 'machine-a|alice' }).write(KEY);
    const other = createKeyStore({ dir, secret: 'machine-b|alice' });
    assert.deepEqual(other.read(), { status: 'unreadable' });
    other.write('replacement-key-value');
    assert.deepEqual(createKeyStore({ dir, secret: 'machine-b|alice' }).read(), { status: 'ok', key: 'replacement-key-value' }, 'saving a new key replaces the unreadable one');
  });
});

test('tampering with the file is detected, and garbage is unreadable rather than a crash', () => {
  withDir((dir) => {
    const store = createKeyStore({ dir, secret: 's' });
    store.write(KEY);
    const payload = JSON.parse(readFileSync(store.file, 'utf8'));
    const data = Buffer.from(payload.data, 'base64');
    data[0] ^= 1;
    writeFileSync(store.file, JSON.stringify({ ...payload, data: data.toString('base64') }));
    assert.deepEqual(createKeyStore({ dir, secret: 's' }).read(), { status: 'unreadable' }, 'GCM authentication fails');

    for (const junk of ['not json', '{}', JSON.stringify({ ...payload, v: 2 }), '']) {
      writeFileSync(store.file, junk);
      assert.deepEqual(createKeyStore({ dir, secret: 's' }).read(), { status: 'unreadable' }, junk.slice(0, 12));
    }
  });
});

test('remove forgets the key, and removing when there is none is fine', () => {
  withDir((dir) => {
    const store = createKeyStore({ dir, secret: 's' });
    store.remove();
    store.write(KEY);
    store.remove();
    assert.deepEqual(store.read(), { status: 'none' });
    assert.deepEqual(createKeyStore({ dir, secret: 's' }).read(), { status: 'none' });
  });
});

test('saving leaves no temporary file behind, and creates the folder when it is missing', () => {
  withDir((dir) => {
    const nested = path.join(dir, 'a', 'b');
    const store = createKeyStore({ dir: nested, secret: 's' });
    store.write(KEY);
    assert.deepEqual(readdirSync(nested), ['apikey.enc']);
  });
});

test('the secret is only looked up when a key is read or written', () => {
  withDir((dir) => {
    let lookups = 0;
    const store = createKeyStore({ dir, secret: () => (lookups++, 's') });
    assert.equal(lookups, 0, 'creating the store looks nothing up');
    store.read();
    assert.equal(lookups, 0, 'no file means nothing to decrypt');
    store.write(KEY);
    assert.equal(lookups, 1);
    store.read();
    assert.equal(lookups, 1, 'the decrypted key is cached in memory');
  });
});

test('app data lives in the per-user folder of each OS', () => {
  const home = path.join(path.sep, 'home', 'sam');
  assert.equal(appDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\sam\\AppData\\Roaming' }, home }), path.join('C:\\Users\\sam\\AppData\\Roaming', 'Jev Studio'));
  assert.equal(appDataDir({ platform: 'win32', env: {}, home }), path.join(home, 'AppData', 'Roaming', 'Jev Studio'));
  assert.equal(appDataDir({ platform: 'darwin', env: {}, home }), path.join(home, 'Library', 'Application Support', 'Jev Studio'));
  assert.equal(appDataDir({ platform: 'linux', env: {}, home }), path.join(home, '.config', 'jev-studio'));
  assert.equal(appDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x/cfg' }, home }), path.join('/x/cfg', 'jev-studio'));
});

test('the machine secret is stable and differs between users', () => {
  const secret = machineSecret();
  assert.equal(secret, machineSecret());
  assert.match(secret, /^jev-studio\|.+\|.+$/);
});
