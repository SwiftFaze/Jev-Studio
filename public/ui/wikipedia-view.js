import { h } from '../dom.js';
import { answerCard, pct } from '../results.js';

// Shared by the Wikipedia answer page and a saved answer's page: how an answer, what a run cost, and each step Jev took are drawn.
// Every step Jev was asked about is drawn as the same card the Single page draws for an answer: the question it was asked, the
// option it picked, how sure it was, and a bar for every option. Everything shown is text from Wikipedia or from a run, drawn as text.

// classify/gate are step 0 (per the plan); refine was missing here before (a pre-existing gap, fixed in passing); the
// Multi-Part/Comparison/Negation steps get their own numbers rather than reusing 1-5's single-entity meaning.
const STEP_NUMBERS = { classify: 0, gate: 0, term: 1, article: 2, part: 3, answer: 4, check: 5, refine: 6, subquestion: 1, compare: 2, negation: 4 };
const QUOTED = new Set(['term', 'answer']); // a step whose pick is text taken from somewhere, shown in quotes
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const number = (n) => n.toLocaleString('en-US');

/** A link to where an answer came from: the article, and the part of it. Always an address on Wikipedia (see articleUrl). */
export const sourceLink = (answer) =>
  h('a', { href: answer.url, target: '_blank', rel: 'noopener noreferrer' }, answer.part && answer.part !== 'Lead' ? `${answer.title} › ${answer.part}` : answer.title);

/** The answer, and only the answer: the quote, and where it is from. */
export function answerBlock(answer) {
  return h('div', { class: 'wiki-answer is-found' }, h('blockquote', { class: 'wiki-quote' }, answer.text), h('p', { class: 'wiki-source small' }, 'From ', sourceLink(answer)));
}

/* ---------- what it cost ---------- */

const stat = (label, value, { wide = false } = {}) => h('div', { class: `wiki-stat${wide ? ' is-wide' : ''}` }, h('span', { class: 'wiki-stat-label' }, label), h('span', { class: 'wiki-stat-value' }, value));

/**
 * The numbers for a run: requests to Jev, tokens, time, articles read, the last check and the search terms tried.
 * `requestLimit` is the limit it ran under (null or Infinity for none); `checked` is the final Yes / No, when there was an answer.
 */
export function statsView(stats, { checked = null, requestLimit = null } = {}) {
  const limited = Number.isFinite(requestLimit) && requestLimit != null;
  const cells = [
    stat('Requests to Jev', limited ? `${stats.requests} of ${requestLimit}` : String(stats.requests)),
    stat('Tokens', number(stats.tokens)),
    stat('Time', `${(stats.ms / 1000).toFixed(1)} s`),
    stat('Articles read', String(stats.articles)),
    checked != null ? stat('Final check', pct(checked)) : null,
    stats.terms.length ? stat(stats.terms.length === 1 ? 'Search term' : 'Search terms', stats.terms.map((t) => `“${t}”`).join(' · '), { wide: true }) : null,
  ];
  return h('div', { class: 'wiki-stats' }, cells);
}

/* ---------- the steps ---------- */

/** The instruction Jev was given names things in backticks (`question`, `article`); show what they stood for. */
const fill = (text, state) => text.replace(/`(\w+)`/g, (whole, key) => (typeof state?.[key] === 'string' && state[key] ? `“${clip(state[key], 160)}”` : whole));

/** How concentrated some probabilities are, 0 to 1: for a step saved without Jev's own confidence. */
function concentration(probs) {
  const values = probs.filter((p) => p > 0);
  const total = values.reduce((a, b) => a + b, 0);
  if (values.length < 2 || total <= 0) return values.length ? 1 : 0;
  const entropy = -values.reduce((sum, p) => sum + (p / total) * Math.log(p / total), 0);
  return 1 - entropy / Math.log(values.length);
}

/** A Choice step as the Single page's card, with every option Jev was given (a long list scrolls inside the card). */
function choiceCard(id, source) {
  const options = source.options;
  const q = { type: 'choice', instructions: fill(source.instructions, source.state), criteria: Object.fromEntries(options.map((o) => [o.key, o.label])) };
  const a = {
    type: 'choice',
    choice: source.chosen || options[0].key,
    probabilities: Object.fromEntries(options.map((o) => [o.key, o.p])),
    confidence: source.confidence ?? concentration(options.map((o) => o.p)),
  };
  return answerCard(id, q, a);
}

const noteLine = (text) => (text ? h('p', { class: 'wiki-note small muted' }, text) : null);
/** A step that took no request of its own, or was skipped: one line, not a card. */
const slimStep = (step, number) =>
  h(
    'div',
    { class: 'wiki-slim' },
    h('span', { class: 'wiki-slim-title' }, `${number}. ${step.title}`),
    h('span', { class: 'wiki-slim-label' }, step.label),
    step.skipped ? h('span', { class: 'muted small' }, `Skipped: ${step.skipped}`) : h('span', { class: 'wiki-slim-pct' }, pct(step.p)),
    step.skipped || !step.note ? null : h('span', { class: 'muted small' }, step.note),
  );

/**
 * One step of the trail. A step Jev was asked about is a fold-out, closed by default: its header says what Jev picked and how
 * sure it was, and opening it shows the full card (a Choice card or a Yes / No card, the same as on the Single page). A step
 * that took no request of its own, or was skipped, is one line. `open` and `onToggle` let the page remember which are open.
 */
function stepView(step, { chosenText, index, open, onToggle }) {
  const number = STEP_NUMBERS[step.id];
  const asked = Boolean(step.instructions) && !step.reused && !step.skipped;
  if (!asked) return h('div', { class: 'wiki-step' }, slimStep(step, number));

  let card;
  if (step.id === 'check') card = answerCard(`${number}. Check`, { type: 'noul', instructions: fill(step.instructions, step.state) }, { type: 'noul', noul: step.p });
  else if (step.options?.length) card = choiceCard(`${number}. ${step.title}`, step);
  else return h('div', { class: 'wiki-step' }, slimStep(step, number));

  const chosen = step.id === 'answer' && chosenText && step.label === chosenText;
  const meaning = step.meaning?.options?.length ? choiceCard('What it asks for', step.meaning) : null;
  const label = QUOTED.has(step.id) ? `“${step.label}”` : step.label;

  const fold = h(
    'details',
    { class: `wiki-fold${chosen ? ' is-chosen' : ''}` },
    h('summary', {}, h('span', { class: 'wiki-fold-title' }, `${number}. ${step.id === 'check' ? 'Check' : step.title}`), h('span', { class: 'wiki-fold-label' }, label), h('span', { class: 'wiki-fold-pct' }, pct(step.p))),
    h('div', { class: 'wiki-fold-body' }, card, noteLine(step.note), meaning),
  );
  fold.open = open.has(index);
  fold.addEventListener('toggle', () => onToggle(index, fold.open));
  return h('div', { class: 'wiki-step' }, fold);
}

/**
 * The trail, step by step. `chosenText` is the sentence that became the answer, to mark it. While a run is going, `pending`
 * is a line saying what it is waiting for. `open` is the set of step numbers (their place in the trail) that are unfolded,
 * and `onToggle(index, open)` is told when one is folded or unfolded, so a page that draws the trail again as it grows can keep them.
 */
export function stepsView(trail, { chosenText = '', pending = '', open = new Set(), onToggle = () => {} } = {}) {
  const steps = trail.map((step, index) => stepView(step, { chosenText, index, open, onToggle }));
  if (pending) steps.push(h('div', { class: 'wiki-step' }, h('div', { class: 'wiki-slim is-pending' }, h('span', { class: 'muted small' }, pending))));
  const root = h('div', { class: 'wiki-steps' });
  const setAll = (value) => {
    for (const fold of root.querySelectorAll('details.wiki-fold')) fold.open = value;
  };
  const tools = trail.some((step) => step.instructions && !step.reused && !step.skipped)
    ? h(
        'div',
        { class: 'wiki-fold-tools' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setAll(true) }, 'Expand all'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setAll(false) }, 'Collapse all'),
      )
    : null;
  root.append(...[tools, ...steps].filter(Boolean));
  return root;
}
