import test from 'node:test';
import assert from 'node:assert/strict';
import { exportItems, formatBytes, MAX_INPUT_BYTES, readableText } from '../public/lib/files.js';
import { parseCsv } from '../public/lib/csv.js';
import { analyzeCsv, applyExpected, itemsFromCsv, parseItems } from '../public/lib/batch.js';

test('readableText drops a BOM and unifies line endings', () => {
  assert.equal(readableText('﻿line one\r\nline two\rline three\n'), 'line one\nline two\nline three\n');
  assert.equal(readableText('plain'), 'plain');
  assert.equal(readableText(''), '');
});

test('readableText refuses binary files (NUL bytes) with a readable message', () => {
  assert.throws(() => readableText('PK\u0003\u0004\u0000\u0000data'), /does not look like a text file/);
});

test('one input limit leaves room in the 1 MB request body', () => {
  assert.ok(MAX_INPUT_BYTES <= 500_000);
  assert.equal(formatBytes(MAX_INPUT_BYTES), '500 KB');
  assert.equal(formatBytes(2_000_000), '2 MB');
  assert.equal(formatBytes(1_500_000), '1.5 MB');
});

test('exportItems: plain items become one line each', () => {
  const out = exportItems([{ text: 'first', expected: {} }, { text: 'second' }]);
  assert.equal(out.ext, 'txt');
  assert.equal(out.mime, 'text/plain');
  assert.equal(out.text, 'first\nsecond\n');
  assert.deepEqual(parseItems(out.text).items.map((i) => i.text), ['first', 'second'], 'round-trips through the text import');
});

test('exportItems: items with expected answers become a CSV that imports straight back, expected answers included', () => {
  const items = [
    { text: 'Payouts failing, this is urgent!', expected: { is_urgent: 'yes', department: 'billing' } },
    { text: 'Do you have an "enterprise" plan?', expected: { is_urgent: 'no' } },
    { text: 'no labels on this one', expected: {} },
  ];
  const out = exportItems(items);
  assert.equal(out.ext, 'csv');
  assert.equal(out.mime, 'text/csv');

  const rows = parseCsv(out.text);
  assert.deepEqual(rows[0], ['text', 'expected_is_urgent', 'expected_department']);

  const info = analyzeCsv(rows, ['department', 'is_urgent']);
  assert.equal(info.hasHeader, true);
  assert.equal(info.textIndex, 0);
  assert.deepEqual(info.expected, { is_urgent: 1, department: 2 });
  assert.deepEqual(itemsFromCsv(rows, info).items, items, 'text (with commas and quotes) and expected answers survive the round trip');
});

test('exportItems neutralises formula-looking text, like every other CSV this app writes', () => {
  const out = exportItems([{ text: '=HYPERLINK("http://evil")', expected: { q: 'yes' } }]);
  assert.ok(out.text.includes("'=HYPERLINK"), out.text);
});

test('an exported items file, edited and re-imported, keeps expected answers attached to the right lines', () => {
  const items = [{ text: 'a', expected: { q: 'yes' } }, { text: 'b', expected: { q: 'no' } }];
  const rows = parseCsv(exportItems(items).text);
  const imported = itemsFromCsv(rows, analyzeCsv(rows, ['q'])).items;
  // the user deletes line "a" and adds a new one, as the batch text box allows
  const edited = applyExpected(parseItems('b\nnew line').items, imported);
  assert.deepEqual(edited.map((i) => i.expected), [{ q: 'no' }, {}]);
});
