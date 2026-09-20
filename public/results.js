import { h } from './dom.js';

export const pct = (p) => (p > 0 && p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`);

export function bar(p, { winner = false } = {}) {
  const fill = h('div', { class: `bar-fill${winner ? ' is-winner' : ''}` });
  fill.style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;
  return h('div', { class: 'bar' }, fill);
}

function confidence(c) {
  return h(
    'div',
    {
      class: 'confidence',
      title: 'How concentrated the probability is on one answer. It is not a guarantee the answer is correct.',
    },
    h('span', { class: 'muted small' }, 'Confidence'),
    bar(c),
    h('strong', { class: 'small' }, pct(c)),
  );
}

function noulBody(a) {
  const yes = a.noul >= 0.5;
  const mid = h('div', { class: 'bar-mid', title: '50%' });
  return [
    h(
      'div',
      { class: 'verdict' },
      h('span', { class: `chip ${yes ? 'chip-yes' : 'chip-no'}` }, yes ? 'Yes' : 'No'),
      h('span', { class: 'big' }, pct(a.noul)),
      h('span', { class: 'muted' }, 'chance of yes'),
    ),
    h('div', { class: 'bar-wrap' }, bar(a.noul, { winner: yes }), mid),
    h('p', { class: 'hint small' }, 'Close to 50% means yes and no are about equally likely.'),
  ];
}

function choiceBody(a, q) {
  const rows = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
  return [
    h('div', { class: 'verdict' }, h('span', { class: 'chip chip-pick' }, a.choice), confidence(a.confidence)),
    h(
      'div',
      { class: 'prob-list' },
      rows.map(([key, p]) => {
        const desc = q.criteria?.[key];
        return h(
          'div',
          { class: `prob-row${key === a.choice ? ' is-top' : ''}` },
          h('div', { class: 'prob-label' }, h('span', { class: 'prob-key' }, key), desc && h('span', { class: 'muted small' }, desc)),
          bar(p, { winner: key === a.choice }),
          h('span', { class: 'prob-pct' }, pct(p)),
        );
      }),
    ),
  ];
}

function scoreBody(a, q) {
  const legend = a.legend ?? Object.fromEntries((q.criteria ?? []).map((l, i) => [String(i), l]));
  const levels = Object.keys(legend).sort((x, y) => x - y);
  const max = Math.max(levels.length - 1, 1);
  const marker = h('div', { class: 'scale-marker', title: `Score ${a.score.toFixed(2)}` });
  marker.style.left = `${(a.score / max) * 100}%`;

  return [
    h(
      'div',
      { class: 'verdict' },
      h('span', { class: 'big' }, a.score.toFixed(2)),
      h('span', { class: 'muted' }, `on a 0 to ${levels.length - 1} scale`),
      confidence(a.confidence),
    ),
    h(
      'div',
      { class: 'scale' },
      h('div', { class: 'scale-track' }, marker),
      h('div', { class: 'scale-ticks' }, levels.map((l) => h('span', {}, l))),
    ),
    h(
      'div',
      { class: 'prob-list' },
      levels.map((l) =>
        h(
          'div',
          { class: 'prob-row' },
          h('div', { class: 'prob-label prob-label-inline' }, h('span', { class: 'prob-key' }, `${l}`), h('span', { class: 'muted small' }, legend[l])),
          bar(a.probabilities?.[l] ?? 0),
          h('span', { class: 'prob-pct' }, pct(a.probabilities?.[l] ?? 0)),
        ),
      ),
    ),
    h('p', { class: 'hint small' }, 'The score is probability-weighted, so it can fall between levels.'),
  ];
}

export function answerCard(id, q, a) {
  let body;
  if (!a) body = h('p', { class: 'muted' }, 'No answer was returned for this question.');
  else if (a.type === 'noul') body = noulBody(a);
  else if (a.type === 'choice') body = choiceBody(a, q);
  else if (a.type === 'score') body = scoreBody(a, q);
  else body = h('pre', { class: 'code' }, JSON.stringify(a, null, 2));

  return h(
    'article',
    { class: 'a-card' },
    h('header', { class: 'a-head' }, h('h3', { class: 'mono' }, id), h('span', { class: 'tag' }, typeLabel(q.type))),
    h('p', { class: 'a-question' }, typeof q.instructions === 'string' ? q.instructions : JSON.stringify(q.instructions)),
    body,
  );
}

const typeLabel = (t) => ({ choice: 'Choice', noul: 'Yes / No', score: 'Score' })[t] ?? t;

export function renderAnswers(root, run) {
  const { request, response, latencyMs, mock } = run;
  const usage = response.usage;

  const answers = h(
    'div',
    { class: 'answers' },
    Object.entries(request.questions).map(([id, q]) => answerCard(id, q, response.answers?.[id])),
  );

  const meta = [
    response.model,
    latencyMs != null && `${latencyMs} ms`,
    usage && `${usage.input_tokens} in / ${usage.output_tokens} out tokens`,
  ].filter(Boolean);

  // replaceChildren stringifies non-nodes (`false` would become the text "false"), so only pass real nodes.
  root.replaceChildren(
    ...[
      mock && h('p', { class: 'notice' }, 'Sample data from mock mode. These are not real Jev answers.'),
      h('p', { class: 'muted small results-meta' }, meta.join(' · ')),
      answers,
    ].filter(Boolean),
  );
}

export function renderError(root, message, details = []) {
  root.replaceChildren(
    h(
      'div',
      { class: 'error', role: 'alert' },
      h('strong', {}, message),
      details.length > 0 && h('ul', {}, details.map((d) => h('li', {}, d))),
    ),
  );
}

export function renderBusy(root) {
  root.replaceChildren(h('p', { class: 'muted busy' }, 'Asking Jev…'));
}
