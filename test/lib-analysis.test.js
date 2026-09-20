import test from 'node:test';
import assert from 'node:assert/strict';
import { answerLabel, certainty, nearestLevel } from '../public/lib/answers.js';
import { reviewCurve, reviewReasons, reviewSummary } from '../public/lib/review.js';
import { accuracyReport, collectVerdicts, expectedMatches, suggestThreshold, verdictFor } from '../public/lib/accuracy.js';
import { compositeScore, componentValue, defaultSpecs, mergeSpecs } from '../public/lib/composite.js';
import { sortRows } from '../public/lib/table.js';

const questions = {
  urgent: { type: 'noul', instructions: 'Urgent?' },
  dept: { type: 'choice', instructions: 'Team?', criteria: { billing: null, tech: null, other: null } },
  mood: { type: 'score', instructions: 'Mood?', criteria: ['calm', 'annoyed', 'angry', 'furious'] },
};

const noul = (p) => ({ type: 'noul', noul: p });
const choice = (key, confidence, probabilities) => ({ type: 'choice', choice: key, confidence, probabilities });
const score = (s, confidence) => ({ type: 'score', score: s, confidence, legend: { 0: 'calm', 1: 'annoyed', 2: 'angry', 3: 'furious' }, probabilities: {} });
const row = (index, answers, extra = {}) => ({ index, text: `item ${index}`, status: 'ok', response: { answers }, expected: {}, ...extra });

/* ---------- certainty ---------- */

test('certainty: Yes / No is distance from 50/50; Choice and Score use confidence', () => {
  assert.equal(certainty(noul(0.5)), 0);
  assert.equal(certainty(noul(1)), 1);
  assert.equal(certainty(noul(0)), 1);
  assert.ok(Math.abs(certainty(noul(0.75)) - 0.5) < 1e-9);
  assert.equal(certainty(choice('a', 0.8, {})), 0.8);
  assert.equal(certainty(undefined), null);
  assert.equal(certainty({ type: 'choice' }), null);
});

test('answerLabel and nearestLevel', () => {
  assert.equal(answerLabel(noul(0.7)), 'Yes');
  assert.equal(answerLabel(noul(0.2)), 'No');
  assert.equal(answerLabel(choice('billing', 1, {})), 'billing');
  assert.equal(answerLabel(score(1.234, 1)), '1.23');
  assert.equal(nearestLevel(1.6, 4), 2);
  assert.equal(nearestLevel(9, 4), 3);
  assert.equal(nearestLevel(-1, 4), 0);
});

/* ---------- review flags ---------- */

test('reviewReasons flags uncertain answers, missing answers and failed rows', () => {
  const ids = ['urgent', 'dept'];
  const sure = row(0, { urgent: noul(0.95), dept: choice('billing', 0.9, {}) });
  assert.deepEqual(reviewReasons(sure, ids, 0.5), []);

  const shaky = row(1, { urgent: noul(0.55), dept: choice('tech', 0.2, {}) });
  const reasons = reviewReasons(shaky, ids, 0.5);
  assert.deepEqual(reasons.map((r) => r.id), ['urgent', 'dept']);
  assert.match(reasons[0].reason, /10% certain/);

  assert.equal(reviewReasons(row(2, { urgent: noul(0.9) }), ids, 0.5)[0].reason, 'no answer');
  assert.match(reviewReasons({ index: 3, status: 'error', error: 'boom' }, ids, 0.5)[0].reason, /request failed: boom/);
  assert.deepEqual(reviewReasons({ index: 4, status: 'pending' }, ids, 0.5), []);
});

test('reviewSummary and reviewCurve count finished rows only and grow with the threshold', () => {
  const rows = [
    row(0, { urgent: noul(0.99) }),
    row(1, { urgent: noul(0.8) }),
    row(2, { urgent: noul(0.6) }),
    row(3, { urgent: noul(0.52) }),
    { index: 4, status: 'pending' },
  ];
  assert.deepEqual(reviewSummary(rows, ['urgent'], 0.5), { done: 4, flagged: 2 });
  const curve = reviewCurve(rows, ['urgent'], [0.1, 0.5, 0.9]);
  // certainties are 0.98, 0.6, 0.2, 0.04, so the 52% answer is flagged even at a 10% threshold
  assert.deepEqual(curve.map((c) => c.flagged), [1, 2, 3]);
});

/* ---------- accuracy ---------- */

test('expectedMatches for each type, tolerating case and rejecting unusable expectations', () => {
  assert.equal(expectedMatches(noul(0.9), questions.urgent, 'Yes'), true);
  assert.equal(expectedMatches(noul(0.9), questions.urgent, 'no'), false);
  assert.equal(expectedMatches(noul(0.2), questions.urgent, 'FALSE'), true);
  assert.equal(expectedMatches(noul(0.2), questions.urgent, 'maybe'), null);

  const a = choice('billing', 0.9, { billing: 0.9, tech: 0.1 });
  assert.equal(expectedMatches(a, questions.dept, 'Billing'), true);
  assert.equal(expectedMatches(a, questions.dept, 'tech'), false);
  assert.equal(expectedMatches(a, questions.dept, 'not-an-option'), null);

  assert.equal(expectedMatches(score(1.8, 1), questions.mood, '2'), true);
  assert.equal(expectedMatches(score(1.8, 1), questions.mood, '1'), false);
  assert.equal(expectedMatches(score(1.8, 1), questions.mood, '9'), null);
  assert.equal(expectedMatches(score(1.8, 1), questions.mood, '1.5'), null);
  assert.equal(expectedMatches(noul(0.9), questions.urgent, ''), null);
  assert.equal(expectedMatches(undefined, questions.urgent, 'yes'), null);
});

test('a manual mark beats the imported expected value', () => {
  const r = row(0, { urgent: noul(0.9) }, { expected: { urgent: 'no' } });
  assert.equal(verdictFor(r, questions.urgent, 'urgent', {}), false);
  assert.equal(verdictFor(r, questions.urgent, 'urgent', { '0:urgent': true }), true);
});

test('collectVerdicts skips unlabelled answers and unfinished rows; accuracyReport tallies buckets and thresholds', () => {
  const rows = [
    row(0, { urgent: noul(0.99) }, { expected: { urgent: 'yes' } }), // right, certainty ~0.98
    row(1, { urgent: noul(0.9) }, { expected: { urgent: 'no' } }), // wrong, certainty 0.8
    row(2, { urgent: noul(0.6) }, { expected: { urgent: 'yes' } }), // right, certainty 0.2
    row(3, { urgent: noul(0.55) }, { expected: { urgent: 'no' } }), // wrong, certainty 0.1
    row(4, { urgent: noul(0.9) }), // unlabelled
    { index: 5, status: 'pending' },
  ];
  const verdicts = collectVerdicts(rows, { urgent: questions.urgent }, {});
  assert.equal(verdicts.length, 4);

  const report = accuracyReport(verdicts, 0.5);
  assert.deepEqual(report.overall, { n: 4, correct: 2 });
  assert.deepEqual(report.byQuestion.urgent, { n: 4, correct: 2 });
  assert.deepEqual(report.kept, { n: 2, correct: 1 });
  assert.deepEqual(report.flagged, { n: 2, correct: 1 });
  assert.deepEqual(report.buckets.map((b) => b.n), [2, 0, 0, 1, 1]);
});

test('accuracyReport puts certainty 1.0 in the top bucket', () => {
  const report = accuracyReport([{ index: 0, id: 'q', correct: true, certainty: 1 }], 0.5);
  assert.equal(report.buckets[4].n, 1);
});

test('suggestThreshold needs a minimum sample and picks the lowest threshold reaching the target', () => {
  const few = Array.from({ length: 5 }, (_, i) => ({ index: i, id: 'q', correct: true, certainty: 0.9 }));
  assert.equal(suggestThreshold(few), null, 'too few answers to trust');

  const verdicts = [
    ...Array.from({ length: 10 }, (_, i) => ({ index: i, id: 'q', correct: false, certainty: 0.2 })),
    ...Array.from({ length: 20 }, (_, i) => ({ index: 20 + i, id: 'q', correct: true, certainty: 0.9 })),
  ];
  const s = suggestThreshold(verdicts, { target: 0.9, minKept: 10 });
  assert.ok(s.threshold > 0.2 && s.threshold <= 0.9, String(s.threshold));
  assert.equal(s.n, 20);
  assert.ok(Math.abs(s.coverage - 20 / 30) < 1e-9);
});

/* ---------- composite ---------- */

test('defaultSpecs enables Yes/No and Score, but a Choice needs a target first', () => {
  const specs = defaultSpecs(questions);
  assert.equal(specs.urgent.enabled, true);
  assert.equal(specs.mood.enabled, true);
  assert.equal(specs.dept.enabled, false);
  assert.equal(specs.dept.target, 'billing');
});

test('componentValue normalises to 0..1 and honours invert and Choice target', () => {
  assert.equal(componentValue(noul(0.8), questions.urgent, { invert: false }), 0.8);
  assert.ok(Math.abs(componentValue(noul(0.8), questions.urgent, { invert: true }) - 0.2) < 1e-9);
  assert.equal(componentValue(score(3, 1), questions.mood, {}), 1);
  assert.equal(componentValue(score(1.5, 1), questions.mood, {}), 0.5);
  const c = choice('billing', 1, { billing: 0.7, tech: 0.3 });
  assert.equal(componentValue(c, questions.dept, { target: 'tech' }), 0.3);
  assert.equal(componentValue(c, questions.dept, { target: null }), null);
});

test('compositeScore is a weighted mean; changing weights changes it without new data', () => {
  const r = row(0, { urgent: noul(1), mood: score(0, 1) });
  const specs = { urgent: { enabled: true, weight: 75, invert: false }, mood: { enabled: true, weight: 25, invert: false } };
  assert.equal(compositeScore(r, questions, specs), 0.75);
  specs.mood.weight = 75;
  assert.equal(compositeScore(r, questions, specs), 0.5);
  specs.mood.invert = true; // low mood is now good
  assert.equal(compositeScore(r, questions, specs), 1);
});

test('compositeScore is null for unfinished rows, missing answers, zero weights and nothing enabled', () => {
  const specs = { urgent: { enabled: true, weight: 50, invert: false } };
  assert.equal(compositeScore({ index: 0, status: 'pending' }, questions, specs), null);
  assert.equal(compositeScore(row(0, {}), questions, specs), null);
  assert.equal(compositeScore(row(0, { urgent: noul(1) }), questions, { urgent: { enabled: true, weight: 0 } }), null);
  assert.equal(compositeScore(row(0, { urgent: noul(1) }), questions, { urgent: { enabled: false, weight: 50 } }), null);
});

test('mergeSpecs keeps settings for surviving questions and resets ones whose Choice target vanished', () => {
  const previous = {
    urgent: { enabled: false, weight: 10, invert: true, target: null },
    dept: { enabled: true, weight: 90, invert: false, target: 'gone' },
  };
  const merged = mergeSpecs(questions, previous);
  assert.deepEqual(merged.urgent, previous.urgent);
  assert.equal(merged.dept.target, 'billing');
  assert.equal(merged.mood.weight, 50);
});

/* ---------- table sorting ---------- */

test('sortRows sorts by composite, question value and certainty; unfinished rows always last', () => {
  const specs = { urgent: { enabled: true, weight: 50, invert: false } };
  const rows = [
    row(0, { urgent: noul(0.2), dept: choice('tech', 0.4, {}) }),
    row(1, { urgent: noul(0.9), dept: choice('billing', 0.9, {}) }),
    { index: 2, status: 'pending' },
    row(3, { urgent: noul(0.6), dept: choice('other', 0.1, {}) }),
  ];
  const ctx = { questions, specs };
  const order = (sort) => sortRows(rows, sort, ctx).map((r) => r.index);

  assert.deepEqual(order({ key: 'composite', dir: 'desc' }), [1, 3, 0, 2]);
  assert.deepEqual(order({ key: 'composite', dir: 'asc' }), [0, 3, 1, 2]);
  assert.deepEqual(order({ key: 'q:dept', dir: 'asc' }), [1, 3, 0, 2], 'Choice sorts alphabetically by label');
  assert.deepEqual(order({ key: 'certainty', dir: 'asc' }), [3, 0, 1, 2]);
  assert.deepEqual(order({ key: 'index', dir: 'desc' }), [3, 2, 1, 0]);
});
