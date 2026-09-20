import { certainty } from './answers.js';
import { compositeScore } from './composite.js';
import { reviewReasons } from './review.js';

/**
 * Sort key for a row: a number, a string, or null when there is nothing to sort on.
 * Keys: index, text, flags (how many reasons to review), certainty (lowest across questions), composite,
 * q:<id> (the answer itself: P(yes), the score, or the Choice label) and c:<id> (certainty of that one answer).
 */
export function sortValue(row, key, { questions, specs, minCertainty = 0 }) {
  if (key === 'index') return row.index;
  if (key === 'text') return row.text.toLowerCase();
  if (key === 'flags') {
    const finished = row.status === 'ok' || row.status === 'error';
    return finished ? reviewReasons(row, Object.keys(questions), minCertainty).length : null;
  }
  if (row.status !== 'ok') return null;

  if (key === 'composite') return compositeScore(row, questions, specs);
  if (key === 'certainty') {
    const values = Object.keys(questions)
      .map((id) => certainty(row.response?.answers?.[id]))
      .filter((c) => c != null);
    return values.length ? Math.min(...values) : null;
  }
  if (key.startsWith('c:')) return certainty(row.response?.answers?.[key.slice(2)]);
  if (key.startsWith('q:')) {
    const answer = row.response?.answers?.[key.slice(2)];
    if (!answer) return null;
    if (answer.type === 'noul') return answer.noul;
    if (answer.type === 'score') return answer.score;
    return answer.choice;
  }
  return null;
}

/** Which direction is the natural first click for a key: biggest first for "how much" keys, A-Z / low-first otherwise. */
export const defaultDir = (key) => (key === 'composite' || key === 'flags' ? 'desc' : 'asc');

/** Returns a sorted copy. Rows with nothing to sort on always go last, whichever direction is chosen. */
export function sortRows(rows, sort, ctx) {
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key, ctx);
    const vb = sortValue(b, sort.key, ctx);
    if (va == null && vb == null) return a.index - b.index;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === 'string' || typeof vb === 'string' ? String(va).localeCompare(String(vb)) : va - vb;
    return cmp * dir || a.index - b.index;
  });
}
