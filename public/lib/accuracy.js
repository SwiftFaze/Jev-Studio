import { certainty, levelCount, nearestLevel } from './answers.js';

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

/**
 * Does an answer agree with an expected value? true / false, or null when there is no usable expectation
 * (empty, or not a valid value for that question), so bad labels never count against the model.
 */
export function expectedMatches(answer, question, expected) {
  const e = String(expected ?? '').trim();
  if (!answer || e === '') return null;
  const lower = e.toLowerCase();

  if (answer.type === 'noul') {
    if (YES.has(lower)) return answer.noul >= 0.5;
    if (NO.has(lower)) return answer.noul < 0.5;
    return null;
  }
  if (answer.type === 'choice') {
    const key = Object.keys(answer.probabilities ?? {}).find((k) => k.toLowerCase() === lower);
    return key === undefined ? null : key === answer.choice;
  }
  if (answer.type === 'score') {
    const n = Number(e);
    const count = levelCount(question);
    if (!Number.isInteger(n) || n < 0 || n >= count) return null;
    return nearestLevel(answer.score, count) === n;
  }
  return null;
}

export const markKey = (index, id) => `${index}:${id}`;

/** A manual mark wins; otherwise fall back to the row's imported expected value. */
export function verdictFor(row, question, id, marks = {}) {
  const manual = marks[markKey(row.index, id)];
  if (typeof manual === 'boolean') return manual;
  return expectedMatches(row.response?.answers?.[id], question, row.expected?.[id]);
}

/** Every judged answer (by a mark of yours, or an expected value from your file) with its certainty. */
export function collectVerdicts(rows, questions, marks = {}) {
  const verdicts = [];
  for (const row of rows) {
    if (row.status !== 'ok') continue;
    for (const [id, question] of Object.entries(questions)) {
      const correct = verdictFor(row, question, id, marks);
      if (correct === null) continue;
      verdicts.push({ index: row.index, id, correct, certainty: certainty(row.response.answers[id]) ?? 0 });
    }
  }
  return verdicts;
}

/**
 * Is this answer checked off automatically? Yes when auto check-off is on, the answer is at least `minCertainty`
 * certain (the same line the review flags use, so anything not flagged is checked off), and nothing has judged it yet:
 * no mark of yours and no expected value. This is derived, not stored, so moving the slider changes it live, and it
 * never counts as evidence: approving an answer because it is confident says nothing about whether it is right.
 */
export function isAutoChecked(row, question, id, marks, minCertainty) {
  if (row.status !== 'ok') return false;
  const c = certainty(row.response?.answers?.[id]);
  if (c == null || c < minCertainty) return false;
  return verdictFor(row, question, id, marks) === null;
}

export function countAutoChecked(rows, questions, marks, minCertainty) {
  let count = 0;
  for (const row of rows) {
    for (const [id, question] of Object.entries(questions)) if (isAutoChecked(row, question, id, marks, minCertainty)) count++;
  }
  return count;
}

export const BUCKETS = [
  { label: 'Under 25%', min: 0, max: 0.25 },
  { label: '25-50%', min: 0.25, max: 0.5 },
  { label: '50-75%', min: 0.5, max: 0.75 },
  { label: '75-90%', min: 0.75, max: 0.9 },
  { label: '90-100%', min: 0.9, max: Infinity },
];

const tally = () => ({ n: 0, correct: 0 });
const count = (t, correct) => {
  t.n++;
  if (correct) t.correct++;
};

export function accuracyReport(verdicts, minCertainty) {
  const overall = tally();
  const byQuestion = {};
  const kept = tally();
  const flagged = tally();
  const buckets = BUCKETS.map((b) => ({ ...b, ...tally() }));

  for (const v of verdicts) {
    count(overall, v.correct);
    count((byQuestion[v.id] ??= tally()), v.correct);
    count(v.certainty >= minCertainty ? kept : flagged, v.correct);
    const bucket = buckets.find((b) => v.certainty >= b.min && v.certainty < b.max);
    if (bucket) count(bucket, v.correct);
  }
  return { overall, byQuestion, buckets, kept, flagged };
}

/**
 * Lowest review threshold (in 5% steps) at which the answers you would NOT flag reach the target accuracy.
 * Needs a minimum number of kept answers, because small samples flatter any threshold.
 */
export function suggestThreshold(verdicts, { target = 0.9, minKept = 10 } = {}) {
  for (let step = 0; step <= 19; step++) {
    const threshold = step / 20;
    const kept = verdicts.filter((v) => v.certainty >= threshold);
    if (kept.length < minKept) return null;
    const correct = kept.filter((v) => v.correct).length;
    if (correct / kept.length >= target) return { threshold, n: kept.length, correct, coverage: kept.length / verdicts.length };
  }
  return null;
}
