// Deterministic fake answers in the real response shape, so the UI can be explored without an API key.

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

function distribution(n, rand) {
  const weights = Array.from({ length: n }, () => rand() ** 3 + 0.01);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => round(w / total));
}

// 1 - normalized entropy: 1 when all mass is on one outcome, 0 when uniform.
function concentration(probs) {
  if (probs.length < 2) return 1;
  const entropy = -probs.reduce((sum, p) => sum + (p > 0 ? p * Math.log(p) : 0), 0);
  return round(1 - entropy / Math.log(probs.length));
}

export function mockResponse({ state, questions }) {
  const stateKey = typeof state === 'string' ? state : JSON.stringify(state);
  const answers = {};

  for (const [id, q] of Object.entries(questions)) {
    const rand = mulberry32(fnv1a(`${stateKey}\u0000${id}`));

    if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: round(rand()) };
    } else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const probs = distribution(keys.length, rand);
      const top = probs.indexOf(Math.max(...probs));
      answers[id] = {
        type: 'choice',
        choice: keys[top],
        probabilities: Object.fromEntries(keys.map((k, i) => [k, probs[i]])),
        confidence: concentration(probs),
      };
    } else {
      const probs = distribution(q.criteria.length, rand);
      answers[id] = {
        type: 'score',
        score: round(probs.reduce((sum, p, i) => sum + p * i, 0)),
        legend: Object.fromEntries(q.criteria.map((level, i) => [String(i), level])),
        probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])),
        confidence: concentration(probs),
      };
    }
  }

  const inputTokens = Math.ceil(JSON.stringify({ state, questions }).length / 4);
  return {
    model: 'jev-mock',
    answers,
    usage: { input_tokens: inputTokens, output_tokens: 6 * Object.keys(questions).length },
  };
}
