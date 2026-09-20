import { h } from '../dom.js';
import { app, hasQuestionWork, PAGE_TYPE, save } from './state.js';
import { blankDraft, buildRequest } from '../request.js';
import { renderBuilder } from './builder.js';
import { openSaveSet } from './save-set.js';
import { postRun } from './api.js';
import { renderAnswers, renderBusy, renderError } from '../results.js';
import { resultsToText } from '../lib/export.js';
import { revealPane } from './reveal.js';

const HISTORY_LIMIT = 25;
const $ = (selector) => document.querySelector(selector);

/**
 * One question page: an input box, a run bar and an answers pane. Custom and the Yes / No, Score and Choice pages
 * are the same thing with different questions, so they share this code and differ only by `key`.
 */
export function createWorkspace(key, { onCompare }) {
  const draft = () => app.drafts[key];
  const input = () => $(`#state-input-${key}`);
  const results = () => $(`#${key}-results`);
  const pane = () => $(`#pane-${key}`);
  let running = false;

  function renderState() {
    input().value = draft().stateText;
  }

  /** No answers yet (or cleared): the whole Answers panel is hidden until there is something to show. */
  function resetResults() {
    results().replaceChildren();
    pane().classList.add('pane-empty');
  }

  /** Show a finished run, with shortcuts to copy it or compare it with the last run on this same page. */
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

    // History is newest first. Older entries from before the question pages existed belong to Custom.
    const previous = app.history.slice(app.history.indexOf(entry) + 1).find((e) => (e.page ?? 'custom') === key);
    const compare = previous
      ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => onCompare(previous, entry) }, 'Compare with previous run')
      : null;

    root.prepend(h('div', { class: 'result-actions' }, copy, compare));
  }

  /**
   * New query: start over. The input, the questions (back to one empty card) and the answers are all cleared.
   * Only the questions are worth a confirmation: the input and answers are in History, but questions are not saved
   * anywhere unless they went into a Question set.
   */
  function newQuery() {
    if (hasQuestionWork(draft()) && !confirm('Start a new query? This clears the input, the questions and the answers. Your runs stay in History.')) return;
    app.drafts[key] = blankDraft(PAGE_TYPE[key]);
    save.page(key);
    renderState();
    if (app.mode === key) renderBuilder();
    resetResults();
    document.querySelector('#questions .q-card textarea')?.focus();
  }

  async function run() {
    if (running) return;
    const box = results();
    pane().classList.remove('pane-empty');

    let request;
    try {
      request = buildRequest(draft());
    } catch (err) {
      renderError(box, err.message);
      return revealPane(box);
    }

    running = true;
    const button = $(`#run-${key}`);
    button.disabled = true;
    button.textContent = 'Asking…';
    renderBusy(box);
    revealPane(box);

    try {
      const data = await postRun(request);
      const entry = { ts: Date.now(), page: key, request, response: data, latencyMs: data.latencyMs, mock: data.mock };
      app.history = [entry, ...app.history].slice(0, HISTORY_LIMIT);
      save.history();
      showRun(entry);
      revealPane(box); // again now the answers are in: the page is tall enough to bring them to the top
    } catch (err) {
      renderError(box, err.message, err.details);
      revealPane(box);
    } finally {
      running = false;
      button.disabled = false;
      button.textContent = 'Ask Jev';
    }
  }

  $(`#mode-${key}`).replaceChildren(
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, '1. What should Jev look at?'), h('span', { class: 'tag' }, 'Optional')),
      h('p', { class: 'hint' }, 'The content every question below is judged against. Leave it empty if your questions stand on their own.'),
      h('textarea', {
        id: `state-input-${key}`,
        class: 'text',
        rows: 8,
        'aria-label': 'Input to judge',
        placeholder: 'Paste the text you want Jev to judge, such as a ticket, review, or email. Optional.',
        oninput: (e) => {
          draft().stateText = e.target.value;
          save.page(key);
        },
      }),
    ),
  );

  $(`#runbar-${key}`).replaceChildren(
    h('button', { type: 'button', id: `run-${key}`, class: 'btn btn-primary', onclick: run }, 'Ask Jev'),
    h('button', { type: 'button', id: `save-${key}`, class: 'btn', onclick: openSaveSet, title: 'Save these questions as a question set, or overwrite one' }, 'Save'),
    h('span', { class: 'hint' }, 'Ctrl/⌘ + Enter'),
  );

  renderState();
  resetResults();

  return { run, newQuery, renderState, resetResults, showRun };
}
