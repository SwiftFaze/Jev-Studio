import test from 'node:test';
import assert from 'node:assert/strict';
import { checkKey, MAX_KEY_LENGTH, MIN_KEY_LENGTH, maskKey } from '../public/lib/apikey.js';

const KEY = 'ts_live_0123456789abcdef';

test('a pasted key is trimmed, and a "Bearer " prefix is dropped', () => {
  assert.deepEqual(checkKey(KEY), { ok: true, key: KEY });
  assert.deepEqual(checkKey(`  ${KEY}\n`), { ok: true, key: KEY }, 'surrounding whitespace and the trailing newline from a copy');
  assert.deepEqual(checkKey(`Bearer ${KEY}`), { ok: true, key: KEY });
  assert.deepEqual(checkKey(`bearer   ${KEY}`), { ok: true, key: KEY });
});

test('things that cannot be a key are refused with a reason', () => {
  for (const [text, reason] of [
    ['', /Paste/],
    ['   \n', /Paste/],
    [null, /Paste/],
    [undefined, /Paste/],
    ['two words here-and-more', /spaces/],
    [`${KEY}\n${KEY}`, /spaces or line breaks/],
    ['café-key-value-1', /characters/],
    ['key••••value', /characters/],
    ['short', /too short/],
    ['x'.repeat(MAX_KEY_LENGTH + 1), /too long/],
  ]) {
    const result = checkKey(text);
    assert.equal(result.ok, false, String(text).slice(0, 20));
    assert.match(result.error, reason, String(text).slice(0, 20));
    assert.equal('key' in result, false, 'a refused key is never handed back');
  }
  assert.equal(checkKey('x'.repeat(MAX_KEY_LENGTH)).ok, true, 'the limit itself is allowed');
  assert.equal(checkKey('x'.repeat(MIN_KEY_LENGTH)).ok, true, 'the shortest length is allowed');
  assert.equal(checkKey('x'.repeat(MIN_KEY_LENGTH - 1)).ok, false);
});

test('the server would accept every key the app accepts (the two checks agree)', () => {
  // src/server.js refuses a key header that is over MAX_KEY_LENGTH or has anything outside printable ASCII.
  for (const text of [KEY, `Bearer ${KEY}`, 'a-b_c.d~e+f/g=h:i0123']) {
    const result = checkKey(text);
    assert.equal(result.ok, true, text);
    assert.ok(result.key.length <= MAX_KEY_LENGTH);
    assert.ok(/^[!-~]+$/.test(result.key), text);
  }
});

test('maskKey shows enough to recognise a key and never enough to use it', () => {
  assert.equal(maskKey(KEY), 'ts_••••cdef');
  assert.equal(maskKey('short-key'), 'sho••••-key');
  for (const key of ['abcdefgh', 'abc', '']) assert.equal(maskKey(key), '••••', 'a short key is hidden entirely');
  assert.equal(maskKey(KEY).includes(KEY.slice(3, -4)), false);
});
