import { levelCount } from './answers.js';
import { reviewReasons } from './review.js';
import { compositeScore } from './composite.js';
import { collectVerdicts, verdictFor } from './accuracy.js';

const TYPE_LABEL = { choice: 'Choice', noul: 'Yes / No', score: 'Score' };
const ITEM_HEADER = { rank: 'candidate', steam: 'review' };
const pct = (p) => `${Math.round(p * 100)}%`;
const round4 = (n) => Math.round(n * 10000) / 10000;

/** A single run as plain text, for pasting into a message or ticket. */
export function resultsToText({ request, response }) {
  const lines = ['Input:', request.state == null ? '(none)' : String(request.state), ''];
  for (const [id, q] of Object.entries(request.questions)) {
    const a = response.answers?.[id];
    const head = `${id} (${TYPE_LABEL[q.type] ?? q.type})`;
    if (!a) {
      lines.push(`${head}: no answer`);
    } else if (a.type === 'noul') {
      lines.push(`${head}: ${a.noul >= 0.5 ? 'Yes' : 'No'}, ${pct(a.noul)} chance of yes`);
    } else if (a.type === 'choice') {
      const spread = Object.entries(a.probabilities)
        .sort((x, y) => y[1] - x[1])
        .map(([key, p]) => `${key} ${pct(p)}`)
        .join(', ');
      lines.push(`${head}: ${a.choice} (confidence ${pct(a.confidence)})`, `  ${spread}`);
    } else if (a.type === 'score') {
      lines.push(`${head}: ${a.score.toFixed(2)} on a 0 to ${levelCount(q) - 1} scale (confidence ${pct(a.confidence)})`);
    }
  }
  return lines.join('\n');
}

function columnNames(id, q) {
  if (q.type === 'noul') return [id, `${id}_p_yes`];
  if (q.type === 'choice') return [id, `${id}_confidence`, ...Object.keys(q.criteria).map((k) => `${id}_p_${k}`)];
  return [id, `${id}_confidence`];
}

function answerCells(answer, q) {
  const blanks = columnNames('', q).map(() => '');
  if (!answer) return blanks;
  if (q.type === 'noul') return [answer.noul >= 0.5 ? 'Yes' : 'No', round4(answer.noul)];
  if (q.type === 'choice') {
    return [answer.choice, round4(answer.confidence), ...Object.keys(q.criteria).map((k) => round4(answer.probabilities?.[k] ?? 0))];
  }
  return [round4(answer.score), round4(answer.confidence)];
}

/** Batch / rank run -> rows for toCsv(): item, one group of columns per question, review flags, composite, agreement. */
export function batchCsvRows(run) {
  const { questions, rows, kind } = run;
  const marks = run.marks ?? {};
  const { minCertainty, compositeOn } = run.settings;
  const ids = Object.keys(questions);
  const hasVerdicts = collectVerdicts(rows, questions, marks).length > 0;

  const header = ['#', ITEM_HEADER[kind] ?? 'item'];
  if (kind === 'steam') header.push('steam_thumbs_up', 'hours_total', 'hours_at_review', 'hours_last_two_weeks', 'votes_helpful', 'refunded', 'free_copy');
  for (const id of ids) header.push(...columnNames(id, questions[id]));
  if (compositeOn) header.push('composite_0_100');
  header.push('needs_review', 'review_reason');
  if (hasVerdicts) for (const id of ids) header.push(`${id}_correct`);

  const body = rows.map((row) => {
    const ok = row.status === 'ok';
    const cells = [row.index + 1, row.text];
    if (kind === 'steam') {
      const m = row.meta ?? {};
      const yesNo = (v) => (v == null ? '' : v ? 'yes' : 'no');
      cells.push(yesNo(m.votedUp), m.hoursTotal ?? '', m.hoursAtReview ?? '', m.hoursRecent ?? '', m.votesUp ?? '', yesNo(m.refunded), yesNo(m.freeCopy));
    }
    for (const id of ids) cells.push(...answerCells(ok ? row.response.answers?.[id] : null, questions[id]));

    if (compositeOn) {
      const score = compositeScore(row, questions, run.specs);
      cells.push(score == null ? '' : Math.round(score * 1000) / 10);
    }
    const reasons = reviewReasons(row, ids, minCertainty);
    const finished = ok || row.status === 'error';
    cells.push(finished ? (reasons.length ? 'yes' : 'no') : '', reasons.map((r) => (r.id ? `${r.id}: ${r.reason}` : r.reason)).join('; '));

    if (hasVerdicts) {
      for (const id of ids) {
        const verdict = ok ? verdictFor(row, questions[id], id, marks) : null;
        cells.push(verdict === null ? '' : verdict ? 'yes' : 'no');
      }
    }
    return cells;
  });
  return [header, ...body];
}
