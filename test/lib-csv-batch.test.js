import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, detectDelimiter, parseCsv, toCsv } from '../public/lib/csv.js';
import {
  analyzeCsv,
  applyExpected,
  executeBatch,
  guessHeader,
  itemsFromCsv,
  MAX_ITEMS,
  parseItems,
  runPool,
} from '../public/lib/batch.js';

/* ---------- CSV ---------- */

test('parseCsv handles quotes, doubled quotes, embedded newlines and CRLF', () => {
  const text = 'a,b\r\n"hello, world","she said ""hi"""\r\n"line1\nline2",x\r\n';
  assert.deepEqual(parseCsv(text), [
    ['a', 'b'],
    ['hello, world', 'she said "hi"'],
    ['line1\nline2', 'x'],
  ]);
});

test('parseCsv strips a BOM, skips blank lines, and keeps a final row with no trailing newline', () => {
  assert.deepEqual(parseCsv('﻿a,b\n\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('parseCsv keeps empty fields and supports semicolon and tab delimiters', () => {
  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']]);
  assert.equal(detectDelimiter('x;y;z\n1;2;3'), ';');
  assert.deepEqual(parseCsv('x\ty\n1\t2'), [['x', 'y'], ['1', '2']]);
});

test('toCsv quotes when needed and round-trips through parseCsv', () => {
  const rows = [['name', 'note'], ['a, b', 'say "x"'], ['multi\nline', 'ok']];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('csvCell guards against spreadsheet formula injection in text but not in numbers', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('+1 555'), "'+1 555");
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell('@user'), "'@user");
  assert.equal(csvCell(-0.5), '-0.5');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(NaN), '');
});

/* ---------- Items ---------- */

test('parseItems: one item per non-blank line, trimmed, capped', () => {
  const { items, truncated } = parseItems('  one \n\n two\r\nthree');
  assert.deepEqual(items.map((i) => i.text), ['one', 'two', 'three']);
  assert.equal(truncated, false);

  const big = parseItems(Array.from({ length: MAX_ITEMS + 5 }, (_, i) => `row ${i}`).join('\n'));
  assert.equal(big.items.length, MAX_ITEMS);
  assert.equal(big.truncated, true);
  assert.equal(big.total, MAX_ITEMS + 5);
});

test('analyzeCsv finds the text column and expected_<question> columns', () => {
  const rows = [
    ['id', 'Message', 'expected_department', 'Expected: is_urgent', 'expected_nonsense'],
    ['1', 'help', 'billing', 'yes', 'x'],
  ];
  const info = analyzeCsv(rows, ['department', 'is_urgent']);
  assert.equal(info.hasHeader, true);
  assert.equal(info.textIndex, 1);
  assert.deepEqual(info.expected, { department: 2, is_urgent: 3 });
  assert.deepEqual(info.unmatched, ['expected_nonsense']);
  assert.equal(info.rowCount, 1);
});

test('analyzeCsv without a header uses the first column; guessHeader is conservative for one column', () => {
  const rows = [['first item'], ['second item']];
  assert.equal(guessHeader(rows), false);
  assert.equal(analyzeCsv(rows, []).textIndex, 0);
  assert.equal(guessHeader([['comment'], ['x']]), true);
  assert.equal(guessHeader([['a', 'b'], ['1', '2']]), true);
});

test('itemsFromCsv flattens line breaks, skips blanks, and keeps only non-empty expected values', () => {
  const rows = [
    ['text', 'expected_dept'],
    ['multi\nline  text', 'billing'],
    ['', 'ignored'],
    ['second', ''],
  ];
  const info = analyzeCsv(rows, ['dept']);
  const { items } = itemsFromCsv(rows, info);
  assert.deepEqual(items, [
    { text: 'multi line  text', expected: { dept: 'billing' } },
    { text: 'second', expected: {} },
  ]);
});

test('applyExpected re-attaches expected answers by text, in order for duplicates', () => {
  const imported = [
    { text: 'a', expected: { q: 'yes' } },
    { text: 'a', expected: { q: 'no' } },
    { text: 'b', expected: { q: 'yes' } },
  ];
  const lines = parseItems('a\nb\na\nnew').items;
  const applied = applyExpected(lines, imported);
  assert.deepEqual(applied.map((i) => i.expected.q), ['yes', 'yes', 'no', undefined]);
  assert.deepEqual(imported[0].expected, { q: 'yes' }, 'does not mutate the imported list');
});

/* ---------- Runner ---------- */

const makeRows = (n) => Array.from({ length: n }, (_, index) => ({ index, text: `item ${index}`, status: 'pending', expected: {} }));
const ans = { answers: { q: { type: 'noul', noul: 0.9 } } };
const httpError = (status, message) => Object.assign(new Error(message), { status });

test('runPool never exceeds the concurrency limit and runs every index', async () => {
  let inFlight = 0;
  let peak = 0;
  const seen = [];
  await runPool([0, 1, 2, 3, 4, 5, 6], async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(i);
    inFlight--;
  }, { concurrency: 3 });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test('executeBatch records ok and failed rows, and keeps going after an ordinary failure', async () => {
  const rows = makeRows(4);
  const send = async (req) => {
    if (req.state === 'item 1') throw httpError(502, 'upstream boom');
    return ans;
  };
  const { fatal } = await executeBatch({
    rows, indices: [0, 1, 2, 3], concurrency: 2, send,
    requestFor: (row) => ({ state: row.text }),
  });
  assert.equal(fatal, null);
  assert.deepEqual(rows.map((r) => r.status), ['ok', 'error', 'ok', 'ok']);
  assert.equal(rows[1].error, 'upstream boom');
  assert.equal('response' in rows[1], false);
});

test('executeBatch stops on a fatal error (bad key) and leaves the rest pending to resume', async () => {
  const rows = makeRows(6);
  let calls = 0;
  const send = async () => {
    calls++;
    throw httpError(401, 'bad key');
  };
  const { fatal } = await executeBatch({
    rows, indices: [0, 1, 2, 3, 4, 5], concurrency: 1, send,
    requestFor: (row) => ({ state: row.text }),
  });
  assert.equal(fatal.status, 401);
  assert.equal(calls, 1, 'no further requests after a fatal error');
  assert.equal(rows[0].status, 'error');
  assert.ok(rows.slice(1).every((r) => r.status === 'pending'));
});

test('executeBatch honours an abort signal: in-flight rows go back to pending, unstarted rows never run', async () => {
  const rows = makeRows(5);
  const ctl = new AbortController();
  const send = (req, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(ans), 30);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  const run = executeBatch({ rows, indices: [0, 1, 2, 3, 4], concurrency: 2, send, requestFor: (r) => ({ state: r.text }), signal: ctl.signal });
  setTimeout(() => ctl.abort(), 10);
  const { fatal } = await run;
  assert.equal(fatal, null);
  assert.ok(rows.every((r) => r.status === 'pending'), rows.map((r) => r.status).join());
});

test('executeBatch can resume just the unfinished rows', async () => {
  const rows = makeRows(3);
  rows[0].status = 'ok';
  rows[0].response = ans;
  const sent = [];
  await executeBatch({
    rows, indices: [1, 2], send: async (req) => (sent.push(req.state), ans),
    requestFor: (r) => ({ state: r.text }),
  });
  assert.deepEqual(sent.sort(), ['item 1', 'item 2']);
  assert.ok(rows.every((r) => r.status === 'ok'));
});
