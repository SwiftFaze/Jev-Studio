import { h } from '../dom.js';
import { app, save } from './state.js';
import { DEFAULT_MODEL } from '../request.js';
import { postRun } from './api.js';
import { renderAnswers, renderBusy, renderError } from '../results.js';
import { resultsToText } from '../lib/export.js';
import { revealPane } from './reveal.js';

const HISTORY_LIMIT = 25;
const $ = (selector) => document.querySelector(selector);

/**
 * The page for one saved question set: its title, what to paste (the set's description), a context box that fills the
 * page, the Ask button, and the answers below. The set's questions are not shown or editable here (that is what "Edit
 * in Single" is for); they simply run on whatever context you paste. One page serves every set, re-pointed by open(id).
 */
export function createSetPage({ onCompare }) {
  let setId = null;
  let running = false;

  const currentSet = () => app.sets.find((s) => s.id === setId) ?? null;
  const input = () => $('#state-input-set');
  const results = () => $('#set-results');
  const pane = () => $('#pane-set');

  const title = h('h2', { id: 'set-title' });
  const lede = h('p', { id: 'set-lede' });

  $('#mode-set').replaceChildren(
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'set-lede' }, title, lede), h('span', { class: 'tag' }, 'Optional')),
      h('textarea', {
        id: 'state-input-set',
        class: 'text',
        rows: 12,
        'aria-label': 'Context to judge',
        placeholder: 'Paste the context to judge. Optional.',
        oninput: (e) => {
          if (!setId) return;
          app.setInputs[setId] = e.target.value;
          save.setInputs();
        },
      }),
    ),
  );

  /** No answers yet (or cleared): the whole Answers panel is hidden until there is something to show. */
  function resetResults() {
    results().replaceChildren();
    pane().classList.add('pane-empty');
  }

  /** Point the page at another set (or refresh it after the set changed). */
  function open(id) {
    setId = id;
    const set = currentSet();
    const count = set ? Object.keys(set.questions).length : 0;
    title.textContent = set?.name ?? 'Question set';
    // The set's own description says what to paste; a set without one gets a plain line.
    lede.textContent = set
      ? set.description || `${count} question${count === 1 ? '' : 's'} run on the context you paste below.`
      : 'This question set no longer exists.';
    lede.className = set?.description ? 'set-description' : 'hint';
    input().value = app.setInputs[id] ?? '';
    resetResults();
  }

  function showRun(entry) {
    const root = results();
    pane().classList.remove('pane-empty');
    renderAnswers(root, entry);

    const copy = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Copy as text');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(resultsToText(entry));
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Copy failed';
      }
      setTimeout(() => (copy.textContent = 'Copy as text'), 1500);
    });

    const previous = app.history.slice(app.history.indexOf(entry) + 1).find((e) => e.page === 'set' && e.setId === entry.setId);
    const compare = previous
      ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => onCompare(previous, entry) }, 'Compare with previous run')
      : null;
    root.prepend(h('div', { class: 'result-actions' }, copy, compare));
  }

  /** New query: clear this set's context and the answers. */
  function newQuery() {
    if (!setId) return;
    app.setInputs[setId] = '';
    save.setInputs();
    input().value = '';
    resetResults();
    input().focus();
  }

  async function run() {
    if (running) return;
    const box = results();
    pane().classList.remove('pane-empty');
    const set = currentSet();
    if (!set) return renderError(box, 'This question set no longer exists.');

    const text = input().value;
    const request = { state: text.trim() === '' ? null : text, model: DEFAULT_MODEL, questions: set.questions };

    running = true;
    const button = $('#run-set');
    button.disabled = true;
    button.textContent = 'Asking…';
    renderBusy(box);
    revealPane(box);

    try {
      const data = await postRun(request);
      const entry = { ts: Date.now(), page: 'set', setId, request, response: data, latencyMs: data.latencyMs, mock: data.mock };
      app.history = [entry, ...app.history].slice(0, HISTORY_LIMIT);
      save.history();
      showRun(entry);
      revealPane(box); // the context box keeps its size, so the answers are below the fold: scroll down to them
    } catch (err) {
      renderError(box, err.message, err.details);
      revealPane(box);
    } finally {
      running = false;
      button.disabled = false;
      button.textContent = 'Ask Jev';
    }
  }

  $('#runbar-set').replaceChildren(
    h('button', { type: 'button', id: 'run-set', class: 'btn btn-primary', onclick: run }, 'Ask Jev'),
    h('span', { class: 'hint' }, 'Ctrl/⌘ + Enter'),
  );

  return { open, run, newQuery, showRun, currentId: () => setId };
}
