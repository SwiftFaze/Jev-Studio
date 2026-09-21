import { h } from '../dom.js';
import { app } from './state.js';
import { compareRuns } from '../lib/compare.js';
import { bar, pct } from '../results.js';

const $ = (selector) => document.querySelector(selector);
const TYPE_LABEL = { choice: 'Choice', noul: 'Yes / No', score: 'Score' };

const snippet = (entry) => {
  const s = entry.request.state;
  const text = s == null || s === '' ? '(no input)' : typeof s === 'string' ? s : JSON.stringify(s);
  return text.length > 50 ? `${text.slice(0, 50)}…` : text;
};
const runLabel = (entry) => `${new Date(entry.ts).toLocaleString()} · ${snippet(entry)}`;

const points = (d) => `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.round(Math.abs(d) * 100)} pts`;
const tone = (d, eps = 0.005) => (Math.abs(d) < eps ? 'flat' : d > 0 ? 'up' : 'down');
const delta = (text, d, eps) => h('span', { class: `delta delta-${tone(d, eps)}` }, text);
const orDash = (p) => (p == null ? '-' : pct(p));

function pair(a, b) {
  return h(
    'div',
    { class: 'pair' },
    h('div', { class: 'pair-line' }, h('span', { class: 'pair-tag' }, 'A'), bar(a ?? 0), h('span', { class: 'small pair-pct' }, orDash(a))),
    h('div', { class: 'pair-line' }, h('span', { class: 'pair-tag' }, 'B'), bar(b ?? 0, { winner: true }), h('span', { class: 'small pair-pct' }, orDash(b))),
  );
}

function questionCard(cq, qa, qb) {
  const notes = [
    cq.wordingChanged && h('span', { class: 'badge badge-warn' }, 'Wording changed'),
    cq.criteriaChanged && h('span', { class: 'badge badge-warn' }, cq.type === 'score' ? 'Levels changed' : 'Options changed'),
  ];
  const head = h('header', { class: 'a-head' }, h('h3', { class: 'mono' }, cq.id), h('span', { class: 'tag' }, TYPE_LABEL[cq.type] ?? cq.type ?? ''), notes);

  let body;
  if (cq.status === 'only-a' || cq.status === 'only-b') {
    body = h('p', { class: 'muted' }, cq.status === 'only-a' ? 'This question is only in run A.' : 'This question is only in run B.');
  } else if (cq.status === 'type-changed') {
    body = h('p', { class: 'muted' }, `Its type changed from ${TYPE_LABEL[cq.typeA]} to ${TYPE_LABEL[cq.typeB]}, so the answers are not comparable.`);
  } else if (cq.status === 'no-answer') {
    body = h('p', { class: 'muted' }, 'One of the runs returned no answer for this question.');
  } else if (cq.type === 'noul') {
    body = [
      h('div', { class: 'verdict' }, h('span', { class: 'big' }, `${pct(cq.a)} → ${pct(cq.b)}`), h('span', { class: 'muted' }, 'chance of yes'), delta(points(cq.delta), cq.delta), cq.flipped && h('span', { class: 'badge badge-bad' }, 'Answer flipped')),
      pair(cq.a, cq.b),
    ];
  } else {
    const rows = cq.options.map((o) =>
      h('div', { class: 'cmp-row' }, h('div', { class: `prob-label${cq.type === 'score' ? ' prob-label-inline' : ''}` }, h('span', { class: 'prob-key' }, o.key), o.label && h('span', { class: 'muted small' }, o.label)), pair(o.a, o.b), delta(points(o.delta), o.delta)),
    );
    const summary =
      cq.type === 'choice'
        ? h('div', { class: 'verdict' }, h('span', { class: 'chip chip-pick' }, cq.choiceA), '→', h('span', { class: 'chip chip-pick' }, cq.choiceB), cq.changed ? h('span', { class: 'badge badge-bad' }, 'Top choice changed') : h('span', { class: 'muted small' }, 'Same top choice'))
        : h('div', { class: 'verdict' }, h('span', { class: 'big' }, `${cq.a.toFixed(2)} → ${cq.b.toFixed(2)}`), delta(`${cq.delta > 0 ? '+' : cq.delta < 0 ? '−' : '±'}${Math.abs(cq.delta).toFixed(2)}`, cq.delta, 0.005));
    const confidence = h('p', { class: 'muted small' }, `Confidence ${orDash(cq.confidenceA)} → ${orDash(cq.confidenceB)}`);
    body = [summary, confidence, h('div', { class: 'prob-list' }, rows)];
  }

  const wording =
    cq.wordingChanged && qa && qb
      ? h('div', { class: 'wording' }, h('p', { class: 'small' }, h('span', { class: 'muted' }, 'A: '), qa.instructions), h('p', { class: 'small' }, h('span', { class: 'muted' }, 'B: '), qb.instructions))
      : qb
        ? h('p', { class: 'a-question' }, qb.instructions)
        : qa
          ? h('p', { class: 'a-question' }, qa.instructions)
          : null;

  return h('article', { class: 'a-card' }, head, wording, body);
}

function renderComparison(root, a, b) {
  const cmp = compareRuns(a, b);
  root.replaceChildren(
    h('p', { class: 'muted small' }, cmp.inputChanged ? 'The input differs between the runs.' : 'Same input in both runs, so any differences come from the questions.'),
    h('div', { class: 'answers' }, cmp.questions.map((cq) => questionCard(cq, a.request.questions[cq.id], b.request.questions[cq.id]))),
  );
}

let selection = { a: null, b: null };
let selectA;
let selectB;

function render() {
  const root = $('#compare-results');
  if (app.history.length < 2) {
    root.replaceChildren(h('p', { class: 'muted' }, 'Run at least two queries on a question page (Single, Yes / No, Score or Choice), then compare them here. Change one thing between runs (the input, or the wording of a question) to see what it does to the answers.'));
    return;
  }
  const a = app.history[Number(selectA.value)];
  const b = app.history[Number(selectB.value)];
  if (!a || !b || a === b) {
    root.replaceChildren(h('p', { class: 'muted' }, 'Pick two different runs.'));
    return;
  }
  selection = { a, b };
  renderComparison(root, a, b);
}

/** Rebuild the pickers from History, keeping the current picks when they still exist. */
export function refreshCompare() {
  const options = () => app.history.map((entry, i) => h('option', { value: String(i) }, runLabel(entry)));
  selectA.replaceChildren(...options());
  selectB.replaceChildren(...options());
  const at = (entry, fallback) => {
    const i = app.history.indexOf(entry);
    return String(i >= 0 ? i : fallback);
  };
  selectA.value = at(selection.a, Math.min(1, app.history.length - 1));
  selectB.value = at(selection.b, 0);
  render();
}

export function openCompare(a, b) {
  selection = { a, b };
  refreshCompare();
}

export function initCompare() {
  selectA = h('select', { id: 'compare-a', 'aria-label': 'Run A (baseline)', onchange: render });
  selectB = h('select', { id: 'compare-b', 'aria-label': 'Run B', onchange: render });
  const swap = h('button', {
    type: 'button',
    id: 'compare-swap',
    class: 'btn btn-ghost btn-sm',
    onclick: () => {
      [selectA.value, selectB.value] = [selectB.value, selectA.value];
      render();
    },
  }, 'Swap');

  $('#mode-compare').replaceChildren(
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Compare two runs')),
      h('p', { class: 'hint' }, 'Pick any two runs from your history. Shown as A (baseline) then B, matched by question id.'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Run A (baseline)'), selectA),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Run B'), selectB),
      swap,
    ),
  );
  refreshCompare();
}
