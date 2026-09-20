import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun } from '../public/lib/overview.js';
import { defaultDir, sortRows, sortValue } from '../public/lib/table.js';
import { certainty } from '../public/lib/answers.js';
import { collectVerdicts, countAutoChecked, isAutoChecked, markKey } from '../public/lib/accuracy.js';

const questions = {
  urgent: { type: 'noul', instructions: 'Urgent?' },
  dept: { type: 'choice', instructions: 'Team?', criteria: { billing: null, tech: null, other: null } },
  mood: { type: 'score', instructions: 'Mood?', criteria: ['calm', 'annoyed', 'angry', 'furious'] },
};
const noul = (p) => ({ type: 'noul', noul: p });
const choice = (key, confidence) => ({ type: 'choice', choice: key, confidence, probabilities: { billing: 0.3, tech: 0.3, other: 0.4 } });
const score = (s, confidence) => ({ type: 'score', score: s, confidence, legend: {}, probabilities: {} });
const row = (index, answers, extra = {}) => ({
  index, text: `Item ${String.fromCharCode(65 + index)}`, status: 'ok', expected: {},
  response: { answers, usage: { input_tokens: 100, output_tokens: 10 } }, ...extra,
});

const run = () => ({
  kind: 'batch',
  questions,
  settings: { minCertainty: 0.5 },
  rows: [
    row(0, { urgent: noul(0.9), dept: choice('billing', 0.9), mood: score(0.2, 0.8) }),
    row(1, { urgent: noul(0.2), dept: choice('billing', 0.4), mood: score(2.6, 0.3) }),
    row(2, { urgent: noul(0.55), dept: choice('tech', 0.7), mood: score(1.4, 0.9) }),
    { index: 3, text: 'Item D', status: 'error', error: 'boom', expected: {} },
    { index: 4, text: 'Item E', status: 'pending', expected: {} },
  ],
});

/* ---------- overview ---------- */

test('summarizeRun: totals, review load, tokens and average certainty', () => {
  const s = summarizeRun(run());
  assert.equal(s.total, 5);
  assert.equal(s.ok, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.notRun, 1);
  assert.equal(s.tokens, 330);
  // rows 1 (0.6 -> ok, 0.4 dept, 0.3 mood) and 2 (0.1 urgent) are uncertain, and the failed row always needs a person
  assert.equal(s.flagged, 3);
  assert.ok(s.meanCertainty > 0.4 && s.meanCertainty < 0.8, String(s.meanCertainty));
});

test('summarizeRun: Yes / No counts, average chance of yes', () => {
  const urgent = summarizeRun(run()).questions.find((q) => q.id === 'urgent');
  assert.equal(urgent.answered, 3);
  assert.equal(urgent.yes, 2);
  assert.equal(urgent.no, 1);
  assert.ok(Math.abs(urgent.meanYes - (0.9 + 0.2 + 0.55) / 3) < 1e-9);
  assert.equal(urgent.uncertain, 1, 'only the 0.55 answer is below 50% certainty');
});

test('summarizeRun: Choice counts include options nobody got, most common first', () => {
  const dept = summarizeRun(run()).questions.find((q) => q.id === 'dept');
  assert.deepEqual(dept.options, [
    { key: 'billing', n: 2 },
    { key: 'tech', n: 1 },
    { key: 'other', n: 0 },
  ]);
});

test('summarizeRun: Score buckets into nearest levels and averages', () => {
  const mood = summarizeRun(run()).questions.find((q) => q.id === 'mood');
  assert.deepEqual(mood.levels.map((l) => l.n), [1, 1, 0, 1], '0.2 -> 0, 1.4 -> 1, 2.6 -> 3');
  assert.deepEqual(mood.levels.map((l) => l.label), ['calm', 'annoyed', 'angry', 'furious']);
  assert.ok(Math.abs(mood.mean - (0.2 + 2.6 + 1.4) / 3) < 1e-9);
});

test('summarizeRun copes with nothing finished yet', () => {
  const empty = { kind: 'batch', questions, settings: { minCertainty: 0.5 }, rows: [{ index: 0, text: 'x', status: 'pending', expected: {} }] };
  const s = summarizeRun(empty);
  assert.equal(s.ok, 0);
  assert.equal(s.meanCertainty, null);
  assert.equal(s.questions[0].answered, 0);
  assert.equal(s.questions[0].meanYes, null);
});

/* ---------- sorting ---------- */

const ctx = { questions, specs: { urgent: { enabled: true, weight: 50, invert: false } }, minCertainty: 0.5 };
const order = (sort, rows = run().rows) => sortRows(rows, sort, ctx).map((r) => r.index);

test('sort by item text is alphabetical and case-insensitive', () => {
  const rows = [
    { index: 0, text: 'banana', status: 'pending' },
    { index: 1, text: 'Apple', status: 'pending' },
    { index: 2, text: 'cherry', status: 'pending' },
  ];
  assert.deepEqual(order({ key: 'text', dir: 'asc' }, rows), [1, 0, 2]);
  assert.deepEqual(order({ key: 'text', dir: 'desc' }, rows), [2, 0, 1]);
});

test('sort by a Yes / No column follows the chance of yes; Choice sorts by label; Score by value', () => {
  assert.deepEqual(order({ key: 'q:urgent', dir: 'desc' }).slice(0, 3), [0, 2, 1]);
  assert.deepEqual(order({ key: 'q:dept', dir: 'asc' }).slice(0, 3), [0, 1, 2], 'billing, billing, tech');
  assert.deepEqual(order({ key: 'q:mood', dir: 'asc' }).slice(0, 3), [0, 2, 1]);
});

test('sort by certainty of one answer, and by flags (most reasons first)', () => {
  assert.deepEqual(order({ key: 'c:mood', dir: 'asc' }).slice(0, 3), [1, 0, 2], 'lowest confidence first');
  const byFlags = order({ key: 'flags', dir: 'desc' });
  assert.equal(sortValue(run().rows[1], 'flags', ctx), 2, 'row 1 has two uncertain answers (dept and mood)');
  assert.equal(byFlags[0], 1, 'the row with the most reasons is first');
  assert.ok(byFlags.indexOf(4) === byFlags.length - 1, 'unfinished rows go last');
});

test('unfinished and failed rows always sort last on answer columns, in both directions', () => {
  for (const dir of ['asc', 'desc']) {
    const o = order({ key: 'q:urgent', dir });
    assert.deepEqual(o.slice(3).sort(), [3, 4], dir);
  }
});

test('natural first-click direction: biggest first for composite and flags, otherwise ascending', () => {
  assert.equal(defaultDir('composite'), 'desc');
  assert.equal(defaultDir('flags'), 'desc');
  for (const key of ['index', 'text', 'certainty', 'q:urgent', 'c:mood']) assert.equal(defaultDir(key), 'asc', key);
});

/* ---------- auto check-off: confident answers are approved, but it is not evidence ---------- */

test('auto check-off: at or above the threshold, still unjudged, finished rows only', () => {
  const qs = { urgent: questions.urgent };
  const at = (index, p, extra) => row(index, { urgent: noul(p) }, extra);
  // Yes / No certainty is distance from 50/50: 0.95 -> 0.9, 0.75 -> 0.5, 0.55 -> 0.1
  const rows = [at(0, 0.95), at(1, 0.75), at(2, 0.55)];
  const checked = (min, marks = {}) => rows.filter((r) => isAutoChecked(r, qs.urgent, 'urgent', marks, min)).map((r) => r.index);

  assert.deepEqual(checked(0.5), [0, 1], 'the threshold itself is included (c >= min), the same line the review flags use');
  assert.deepEqual(checked(0.9), [0]);
  assert.deepEqual(checked(0.95), [], 'nothing reaches it');
  assert.equal(countAutoChecked(rows, qs, {}, 0.5), 2);

  const unfinished = [at(3, 0.95, { status: 'pending' }), at(4, 0.95, { status: 'error', response: null })];
  assert.equal(countAutoChecked(unfinished, qs, {}, 0), 0, 'unfinished and failed rows are never checked off');
});

test('auto check-off never overrides a judgment: your mark or an expected value wins', () => {
  const qs = { urgent: questions.urgent };
  const rows = [
    row(0, { urgent: noul(0.99) }),
    row(1, { urgent: noul(0.99) }),
    row(2, { urgent: noul(0.99) }, { expected: { urgent: 'no' } }),
  ];
  const marks = { [markKey(0, 'urgent')]: false, [markKey(1, 'urgent')]: true };
  assert.equal(isAutoChecked(rows[0], qs.urgent, 'urgent', marks, 0.5), false, 'a manual ✗ stands');
  assert.equal(isAutoChecked(rows[1], qs.urgent, 'urgent', marks, 0.5), false, 'a manual ✓ is already a judgment');
  assert.equal(isAutoChecked(rows[2], qs.urgent, 'urgent', {}, 0.5), false, 'an expected value already judges it');
  assert.equal(countAutoChecked(rows, qs, marks, 0.5), 0);
});

test('auto check-off ignores answers with no certainty, and is not evidence for accuracy', () => {
  const qs = { mood: questions.mood };
  const noConfidence = row(0, { mood: { type: 'score', score: 1, legend: {}, probabilities: {} } });
  assert.equal(isAutoChecked(noConfidence, qs.mood, 'mood', {}, 0), false, 'null certainty is never approved');
  assert.equal(isAutoChecked(row(1, {}), qs.mood, 'mood', {}, 0), false, 'a missing answer is never approved');

  const confident = row(2, { mood: score(1, 0.99) });
  assert.equal(isAutoChecked(confident, qs.mood, 'mood', {}, 0.5), true);
  assert.deepEqual(collectVerdicts([confident], qs, {}), [], 'a confident answer nobody judged says nothing about accuracy');
});

test('a Yes / No answer of 95% is exactly 90% certain, so it clears a 90% line (no floating-point shortfall)', () => {
  assert.equal(certainty(noul(0.95)), 0.9);
  assert.equal(certainty(noul(0.05)), 0.9);
  assert.equal(certainty(noul(0.5)), 0);
  assert.equal(certainty(noul(1)), 1);
  assert.equal(certainty(noul(0.6)), 0.2);
});

test('runProgress: finished rows are answered plus failed, and the share and tokens follow', async () => {
  const { runProgress } = await import('../public/lib/overview.js');
  const usage = { input_tokens: 90, output_tokens: 10 };
  const p = runProgress([
    { status: 'ok', response: { usage } },
    { status: 'ok', response: { usage } },
    { status: 'error' },
    { status: 'running' },
    { status: 'pending' },
  ]);
  assert.deepEqual(p, { total: 5, ok: 2, failed: 1, done: 3, notRun: 2, share: 0.6, tokens: 200 });
  assert.deepEqual(runProgress([]), { total: 0, ok: 0, failed: 0, done: 0, notRun: 0, share: 0, tokens: 0 });
});
