import { clamp01, levelCount } from './answers.js';

// A composite score turns several answers into one 0..1 number with weights you can change without re-running Jev.
// spec per question: { enabled, weight (0..100), invert (lower is better), target (Choice: which option counts) }

export function defaultSpecs(questions) {
  const specs = {};
  for (const [id, q] of Object.entries(questions)) {
    specs[id] = {
      enabled: q.type !== 'choice', // a Choice needs a target option picked first
      weight: 50,
      invert: false,
      target: q.type === 'choice' ? (Object.keys(q.criteria)[0] ?? null) : null,
    };
  }
  return specs;
}

/** Keep the settings for questions that still exist (same id and type); use defaults for the rest. */
export function mergeSpecs(questions, previous = {}) {
  const fresh = defaultSpecs(questions);
  for (const [id, spec] of Object.entries(fresh)) {
    const old = previous[id];
    if (!old) continue;
    const validTarget = questions[id].type !== 'choice' || old.target in questions[id].criteria;
    if (validTarget) fresh[id] = { ...spec, ...old };
  }
  return fresh;
}

/** One answer as a 0..1 value: P(yes), position on the scale, or P(target option). */
export function componentValue(answer, question, spec) {
  if (!answer) return null;
  let value = null;
  if (answer.type === 'noul') value = answer.noul;
  else if (answer.type === 'score') {
    const max = levelCount(question) - 1;
    value = max > 0 ? answer.score / max : null;
  } else if (answer.type === 'choice') value = spec.target != null ? (answer.probabilities?.[spec.target] ?? 0) : null;

  if (value == null) return null;
  value = clamp01(value);
  return spec.invert ? 1 - value : value;
}

/** Weighted mean of the enabled components, or null if the row is unfinished, has a missing answer, or nothing is enabled. */
export function compositeScore(row, questions, specs) {
  if (row.status !== 'ok') return null;
  let total = 0;
  let weightSum = 0;
  for (const [id, spec] of Object.entries(specs)) {
    if (!spec.enabled || !(spec.weight > 0) || !questions[id]) continue;
    const value = componentValue(row.response?.answers?.[id], questions[id], spec);
    if (value == null) return null;
    total += value * spec.weight;
    weightSum += spec.weight;
  }
  return weightSum > 0 ? total / weightSum : null;
}
