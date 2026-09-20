import { certainty } from './answers.js';

export const DEFAULT_MIN_CERTAINTY = 0.5;
export const CURVE_STEPS = [0.3, 0.5, 0.7, 0.9];

const isDone = (row) => row.status === 'ok' || row.status === 'error';

/** Why a row needs a person to look at it. Failed requests always do; unfinished rows have no opinion yet. */
export function reviewReasons(row, questionIds, minCertainty) {
  if (row.status === 'error') return [{ id: null, reason: `request failed${row.error ? `: ${row.error}` : ''}` }];
  if (row.status !== 'ok') return [];

  const reasons = [];
  for (const id of questionIds) {
    const answer = row.response?.answers?.[id];
    const c = certainty(answer);
    if (c == null) reasons.push({ id, reason: 'no answer' });
    else if (c < minCertainty) reasons.push({ id, reason: `${Math.round(c * 100)}% certain` });
  }
  return reasons;
}

export function reviewSummary(rows, questionIds, minCertainty) {
  const done = rows.filter(isDone);
  const flagged = done.filter((row) => reviewReasons(row, questionIds, minCertainty).length > 0).length;
  return { done: done.length, flagged };
}

/** How many finished rows would be flagged at each threshold, so you can pick one with the numbers in front of you. */
export function reviewCurve(rows, questionIds, steps = CURVE_STEPS) {
  return steps.map((threshold) => ({ threshold, ...reviewSummary(rows, questionIds, threshold) }));
}
