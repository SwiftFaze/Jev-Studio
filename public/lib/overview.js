import { certainty, levelCount, nearestLevel } from './answers.js';
import { reviewReasons } from './review.js';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function summarizeQuestion(id, q, okRows, minCertainty) {
  const answers = okRows.map((row) => row.response.answers?.[id]).filter(Boolean);
  const certainties = answers.map(certainty).filter((c) => c != null);
  const base = {
    id,
    type: q.type,
    answered: answers.length,
    meanCertainty: mean(certainties),
    uncertain: certainties.filter((c) => c < minCertainty).length,
  };

  if (q.type === 'noul') {
    const yes = answers.filter((a) => a.noul >= 0.5).length;
    return { ...base, yes, no: answers.length - yes, meanYes: mean(answers.map((a) => a.noul)) };
  }

  if (q.type === 'choice') {
    const counts = Object.fromEntries(Object.keys(q.criteria).map((key) => [key, 0]));
    for (const a of answers) counts[a.choice] = (counts[a.choice] ?? 0) + 1;
    const options = Object.entries(counts)
      .map(([key, n]) => ({ key, n }))
      .sort((x, y) => y.n - x.n);
    return { ...base, options };
  }

  // Score: bucket each probability-weighted score into its nearest level.
  const count = levelCount(q);
  const levels = Array.from({ length: count }, (_, level) => ({ level, label: q.criteria[level], n: 0 }));
  for (const a of answers) levels[nearestLevel(a.score, count)].n++;
  return { ...base, mean: mean(answers.map((a) => a.score)), levels };
}

/** The numbers behind the Overview panel: progress, review load, and the spread of answers per question. */
export function summarizeRun(run) {
  const ids = Object.keys(run.questions);
  const minCertainty = run.settings?.minCertainty ?? 0;
  const ok = run.rows.filter((r) => r.status === 'ok');
  const failed = run.rows.filter((r) => r.status === 'error').length;

  const questions = ids.map((id) => summarizeQuestion(id, run.questions[id], ok, minCertainty));
  const allCertainties = ok.flatMap((row) => ids.map((id) => certainty(row.response.answers?.[id])).filter((c) => c != null));

  return {
    total: run.rows.length,
    ok: ok.length,
    failed,
    notRun: run.rows.length - ok.length - failed,
    // A failed request always needs a person, so it counts as flagged.
    flagged: run.rows.filter((row) => reviewReasons(row, ids, minCertainty).length > 0).length,
    meanCertainty: mean(allCertainties),
    tokens: run.rows.reduce((sum, r) => sum + (r.response?.usage ? r.response.usage.input_tokens + r.response.usage.output_tokens : 0), 0),
    questions,
  };
}
