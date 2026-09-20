// Side-by-side difference between two single runs ({ request, response }), matched by question id.

const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

function optionRows(keys, a, b) {
  return keys
    .map((key) => ({ key, a: a?.[key] ?? null, b: b?.[key] ?? null, delta: (b?.[key] ?? 0) - (a?.[key] ?? 0) }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

export function compareRuns(a, b) {
  const qa = a.request.questions;
  const qb = b.request.questions;
  const ids = [...new Set([...Object.keys(qa), ...Object.keys(qb)])];

  const questions = ids.map((id) => {
    if (!qa[id] || !qb[id]) return { id, status: qa[id] ? 'only-a' : 'only-b' };
    if (qa[id].type !== qb[id].type) return { id, status: 'type-changed', typeA: qa[id].type, typeB: qb[id].type };

    const base = {
      id,
      status: 'both',
      type: qa[id].type,
      wordingChanged: qa[id].instructions !== qb[id].instructions,
      criteriaChanged: !same(qa[id].criteria, qb[id].criteria),
    };
    const aa = a.response.answers?.[id];
    const ab = b.response.answers?.[id];
    if (!aa || !ab) return { ...base, status: 'no-answer' };

    if (base.type === 'noul') {
      return { ...base, a: aa.noul, b: ab.noul, delta: ab.noul - aa.noul, flipped: aa.noul >= 0.5 !== ab.noul >= 0.5 };
    }

    const keys = [...new Set([...Object.keys(aa.probabilities ?? {}), ...Object.keys(ab.probabilities ?? {})])];
    const common = { confidenceA: aa.confidence, confidenceB: ab.confidence, options: optionRows(keys, aa.probabilities, ab.probabilities) };

    if (base.type === 'choice') {
      return { ...base, ...common, choiceA: aa.choice, choiceB: ab.choice, changed: aa.choice !== ab.choice };
    }
    const legend = { ...(ab.legend ?? {}), ...(aa.legend ?? {}) };
    return {
      ...base,
      ...common,
      a: aa.score,
      b: ab.score,
      delta: ab.score - aa.score,
      options: common.options
        .map((o) => ({ ...o, label: legend[o.key] ?? '' }))
        .sort((x, y) => Number(x.key) - Number(y.key)),
    };
  });

  return { inputChanged: a.request.state !== b.request.state, questions };
}
