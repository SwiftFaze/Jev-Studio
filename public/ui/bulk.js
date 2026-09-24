import { h } from '../dom.js';
import { app, hasQuestionWork, save } from './state.js';
import { applyExpected, executeBatch, MAX_ITEMS, parseItems } from '../lib/batch.js';
import { parseCsv } from '../lib/csv.js';
import { blankDraft, buildQuestions, DEFAULT_MODEL } from '../request.js';
import { renderBuilder } from './builder.js';
import { mergeSpecs } from '../lib/composite.js';
import { DEFAULT_MIN_CERTAINTY } from '../lib/review.js';
import { buildRankState, rankQuestions, rankSpecs } from '../lib/rank.js';
import { postRun } from './api.js';
import { renderBatchResults } from './batch-results.js';
import { revealPane } from './reveal.js';
import { openSaveSet } from './save-set.js';

const CONFIRM_ABOVE = 20; // ask before spending this many live API calls at once
const MAX_FILE_BYTES = 2_000_000;

/**
 * Batch mode (many items, your questions), Rank mode (many candidates, fixed relevance questions) and a Batch-saved
 * set's page (many items, the set's questions) share this controller: one item per request, a table that fills in as
 * they finish. What differs between them is passed in, so there is one runner rather than three.
 *
 * `kind` names the containers (`#mode-<kind>`, `#runbar-<kind>`, `#<kind>-results`, …) and is what a run records as
 * its own kind. Options:
 *  - `slice()` the state this page reads and writes — a function, because a set's page is re-pointed at another set;
 *  - `persist()` how that state is saved;
 *  - `questions()` the questions to run, throwing an Error with a message fit to show, or null when there are none;
 *  - `questionIds()` their ids, for matching a CSV's expected_<id> columns;
 *  - `panelHead` what goes in the input panel's head, in place of the plain heading (a set puts its name there);
 *  - `hideEmptyResults` hide the whole results panel until there is a run, rather than explain what will appear;
 *  - `onReset()` anything else "New query" clears, and `resetAsks()` what else it would throw away.
 */
export function initBulk(kind, { openCsv, slice: sliceOf, persist, questions: questionsOf, questionIds, label, panelHead, hideEmptyResults, onReset, resetAsks, hint, placeholder, saveButton, extraButtons } = {}) {
  const rank = kind === 'rank';
  const slice = () => (sliceOf ? sliceOf() : app[kind]);
  const persistNow = () => (persist ? persist() : save[kind]());
  const $ = (suffix) => document.querySelector(`#${kind}-${suffix}`);
  const pane = () => document.querySelector(`#pane-${kind}`);

  let handle = null;
  let running = false;
  let controller = null;
  let refreshTimer = null;
  let saveTimer = null;

  const persistSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistNow(), 400);
  };
  // Row updates arrive in bursts; redraw the table at most ~5 times a second.
  const scheduleRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      handle?.refresh();
    }, 200);
  };

  const say = (text) => {
    const el = $('status');
    el.textContent = text;
    el.hidden = !text;
  };

  /* ---------- input panel ---------- */
  const noun = rank ? 'candidates' : 'items';
  // A set's page says what to paste in its own description, above the box, so it passes '' and gets no line here.
  const hintLine = hint ?? 'One item per line. Each is judged on its own against the questions below, one request per item.';
  const countEl = h('span', { class: 'muted small' });

  function currentItems() {
    const parsed = parseItems(slice().text);
    return { ...parsed, items: applyExpected(parsed.items, slice().imported) };
  }

  function renderCount() {
    const { items, truncated, total } = currentItems();
    const labelled = items.filter((i) => Object.keys(i.expected).length > 0).length;
    countEl.textContent = [
      `${items.length} ${items.length === 1 ? noun.slice(0, -1) : noun}`,
      truncated && `only the first ${MAX_ITEMS} of ${total} will run`,
      labelled > 0 && `${labelled} with expected answers`,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  const itemsBox = h('textarea', {
    id: `${kind}-items`,
    class: 'text',
    rows: 10,
    'aria-label': rank ? 'Candidates, one per line' : 'Items, one per line',
    placeholder: placeholder ?? (rank ? 'One candidate per line, such as document titles, answers, or product names.' : 'One item per line. Every item is judged against the same questions below.'),
    value: slice().text,
    oninput: (e) => {
      slice().text = e.target.value;
      persistSoon();
      renderCount();
    },
  });

  const queryBox = rank
    ? h('textarea', {
        id: 'rank-query',
        class: 'text',
        rows: 2,
        'aria-label': 'What you are looking for',
        placeholder: 'What are you looking for? For example: how do I get a refund?',
        value: slice().query,
        oninput: (e) => {
          slice().query = e.target.value;
          persistSoon();
        },
      })
    : null;

  const fileInput = rank
    ? null
    : h('input', {
        type: 'file',
        id: `${kind}-file`,
        accept: '.csv,.tsv,.txt,text/csv,text/plain',
        hidden: true,
        onchange: async (e) => {
          const file = e.target.files[0];
          e.target.value = '';
          if (!file) return;
          if (file.size > MAX_FILE_BYTES) return say('That file is too large (2 MB max).');
          const text = await file.text();
          if (/\.(csv|tsv)$/i.test(file.name)) {
            openCsv(file.name, parseCsv(text), {
              // Which expected_<id> columns to look for: the questions this page will run, whoever owns them.
              questionIds: questionIds ? questionIds() : app.drafts.batch.questions.map((q) => q.id.trim()).filter(Boolean),
              onImport: ({ items, truncated, total }) => {
                slice().text = items.map((i) => i.text).join('\n');
                slice().imported = items;
                itemsBox.value = slice().text;
                renderCount();
                persistNow();
                say(truncated ? `Imported the first ${MAX_ITEMS} of ${total} rows.` : `Imported ${items.length} rows.`);
              },
            });
          } else {
            slice().text = text;
            slice().imported = [];
            itemsBox.value = text;
            renderCount();
            persistNow();
            say('');
          }
        },
      });

  const concurrency = h(
    'select',
    {
      id: `${kind}-concurrency`,
      'aria-label': 'Requests at a time',
      onchange: (e) => {
        slice().concurrency = Number(e.target.value);
        persistNow();
      },
    },
    [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n) }, String(n))),
  );
  concurrency.value = String(slice().concurrency);

  document.querySelector(`#mode-${kind}`).replaceChildren(
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, ...(panelHead ?? [h('h2', {}, rank ? '1. What are you looking for?' : '1. What should Jev look at?')])),
      rank
        ? [queryBox, h('h3', {}, 'Candidates'), h('p', { class: 'hint' }, 'Jev scores how well each candidate answers the query, then they are ranked by a weighted score. Nothing is generated: you get probabilities.')]
        : hintLine && h('p', { class: 'hint' }, hintLine),
      itemsBox,
      h(
        'div',
        { class: 'bulk-meta' },
        countEl,
        fileInput && h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => fileInput.click() }, 'Load CSV / text file…'),
        fileInput,
        h('label', { class: 'small' }, 'Run ', concurrency, ' at a time'),
      ),
      rank
        ? h('details', { class: 'explainer' }, h('summary', {}, 'What Jev is asked'), h('ul', {}, Object.entries(rankQuestions()).map(([id, q]) => h('li', {}, h('span', { class: 'mono' }, id), `: ${q.instructions}`))))
        : null,
    ),
  );

  /* ---------- running ---------- */
  const runBtn = h('button', { type: 'button', id: `${kind}-run`, class: 'btn btn-primary', onclick: () => start() }, rank ? 'Rank candidates' : 'Run batch');
  const stopBtn = h('button', { type: 'button', id: `${kind}-stop`, class: 'btn', hidden: true, onclick: () => stop() }, 'Stop');
  const statusEl = h('span', { id: `${kind}-status`, class: 'runbar-status', role: 'status', hidden: true });

  const syncButtons = () => {
    runBtn.disabled = running;
    stopBtn.hidden = !running;
  };

  function stop() {
    controller?.abort();
  }

  async function execute(indices) {
    const run = slice().run;
    controller = new AbortController();
    running = true;
    syncButtons();
    handle?.refresh();

    const { fatal } = await executeBatch({
      rows: run.rows,
      indices,
      concurrency: slice().concurrency,
      signal: controller.signal,
      requestFor: (row) => ({
        state: run.kind === 'rank' ? buildRankState(run.query, row.text) : row.text,
        model: run.model,
        questions: run.questions,
      }),
      send: postRun,
      onUpdate: scheduleRefresh,
    });

    running = false;
    controller = null;
    run.fatal = fatal ? fatal.message : null;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    syncButtons();
    handle?.refresh();
    persistNow();
  }

  function show() {
    pane()?.classList.remove('pane-empty');
    handle = renderBatchResults($('results'), slice().run, {
      onChange: persistSoon,
      onStop: stop,
      onResume: () => execute(slice().run.rows.flatMap((r, i) => (r.status === 'ok' ? [] : [i]))),
      onRetryRow: (i) => !running && execute([i]),
      isRunning: () => running,
    });
  }

  function emptyResults() {
    handle = null;
    // A set's page hides the whole Results panel until there is a run, the same as the other set page does with its
    // Answers panel: the box to paste into fills the height, and nothing sits under it saying there is nothing yet.
    if (hideEmptyResults) {
      $('results').replaceChildren();
      pane()?.classList.add('pane-empty');
      return;
    }
    $('results').replaceChildren(
      h('p', { class: 'muted' }, rank ? 'Ranked candidates appear here as they finish.' : 'Results appear here as each item finishes. Nothing is sent until you press Run.'),
      h(
        'details',
        { class: 'explainer' },
        h('summary', {}, 'What you can do with the results'),
        h('ul', {}, [
          h('li', {}, h('strong', {}, 'Review flags'), ': mark items where Jev was unsure so a person checks them.'),
          h('li', {}, h('strong', {}, rank ? 'Ranking weights' : 'Composite score'), ': combine answers into one score and re-rank with sliders, with no new API calls.'),
          !rank && h('li', {}, h('strong', {}, 'Accuracy check'), ': mark answers ✓ / ✗ (or import expected_<question_id> columns) to see how often Jev agrees, by confidence.'),
          h('li', {}, h('strong', {}, 'Export CSV'), ': everything above in one file.'),
        ]),
      ),
    );
  }

  async function start() {
    if (running) return;
    const { items } = currentItems();

    if (rank && !slice().query.trim()) return say('Enter what you are looking for first.');
    if (items.length === 0) return say(rank ? 'Add at least one candidate.' : 'Add at least one item.');

    let questions;
    try {
      questions = questionsOf ? questionsOf() : rank ? rankQuestions() : buildQuestions(app.drafts.batch.questions);
    } catch (err) {
      return say(err.message);
    }
    if (!questions || Object.keys(questions).length === 0) return say('Add at least one question.');
    if (!app.status.mock && items.length > CONFIRM_ABOVE && !confirm(`This will make ${items.length} API calls with your key. Continue?`)) return;

    say('');
    const previous = slice().run;
    slice().run = {
      kind,
      label: label?.() ?? undefined, // what to call the exported CSV, when the page has a better name than its kind
      questions,
      model: DEFAULT_MODEL,
      query: rank ? slice().query.trim() : undefined,
      rows: items.map((item, index) => ({ index, text: item.text, expected: item.expected, status: 'pending' })),
      marks: {},
      open: null,
      fatal: null,
      specs: rank ? rankSpecs() : mergeSpecs(questions, previous?.specs),
      settings: {
        // Which panels you left open carries over, so opening one once is not undone by the next run.
        panels: { ...previous?.settings?.panels },
        minCertainty: previous?.settings?.minCertainty ?? DEFAULT_MIN_CERTAINTY,
        autoCheck: previous?.settings?.autoCheck ?? false, // off until you choose it: nothing is approved on your behalf by default
        onlyReview: false,
        sort: rank ? { key: 'composite', dir: 'desc' } : { key: 'index', dir: 'asc' },
        // On by default, so the composite score is there from the first run; Rank always ranks by it.
        compositeOn: rank || (previous?.settings?.compositeOn ?? true),
      },
    };
    show();
    revealPane($('results'));
    await execute(slice().run.rows.map((_, i) => i));
  }

  /**
   * New query: start over. Clears the items (or the query and candidates) and the results, plus, for Batch, Batch's
   * own questions. Rank's are fixed and a set's belong to the set, so neither has questions to clear here.
   */
  function reset() {
    if (running) stop();
    // `resetAsks` is what this page loses besides the items and the results; Batch's own questions are the default.
    const alsoAtStake = resetAsks ? resetAsks() : !rank && hasQuestionWork(app.drafts.batch) ? 'the questions' : '';
    const resultsAtStake = slice().run?.rows.some((r) => r.status === 'ok');
    if ((alsoAtStake || resultsAtStake) && !confirm(`Start a new query? This clears the ${rank ? 'query, the candidates' : 'items'}${alsoAtStake ? `, ${alsoAtStake}` : ''} and the results. Batch and rank results are not kept in History.`)) return;
    if (onReset) onReset();
    else if (!rank) {
      app.drafts.batch = { stateText: '', questions: blankDraft().questions };
      save.typed();
      renderBuilder();
    }
    slice().text = '';
    slice().imported = [];
    if (rank) slice().query = '';
    slice().run = null;
    itemsBox.value = '';
    if (queryBox) queryBox.value = '';
    renderCount();
    emptyResults();
    say('');
    persistNow();
    (queryBox ?? itemsBox).focus();
  }

  // replaceChildren (unlike h) would print a `false` child as the text "false", so build the list without it.
  document.querySelector(`#runbar-${kind}`).replaceChildren(
    ...[
      runBtn,
      stopBtn,
      // Batch's questions are its own, so it can save them as a set. Rank's are fixed, and a set's are already saved.
      (saveButton ?? !rank) && h('button', { type: 'button', id: 'save-batch', class: 'btn', onclick: openSaveSet, title: 'Save the questions as a question set, or overwrite one' }, 'Save'),
      ...(extraButtons ?? []),
      statusEl,
    ].filter(Boolean),
  );

  /**
   * Write what the debounce is still holding, now. Typing is saved 400ms after it stops, which is fine while you stay
   * on a page; it is not when the page is about to be pointed at another set's state, so that flushes first.
   */
  function flush() {
    clearTimeout(saveTimer);
    persistNow();
  }

  /** Draw the input and the results from whatever the slice holds now — on start, and when a set's page is re-pointed. */
  function refresh() {
    itemsBox.value = slice().text;
    if (queryBox) queryBox.value = slice().query;
    concurrency.value = String(slice().concurrency);
    renderCount();
    say('');
    if (slice().run) show();
    else emptyResults();
  }

  refresh();
  syncButtons();

  /** Is there anything here that loading an example would throw away? */
  const hasWork = () => slice().text.trim() !== '' || (rank && slice().query.trim() !== '') || Boolean(slice().run?.rows.some((r) => r.status === 'ok'));

  /** Replace the input with an example (or blank) and clear the results. */
  function load({ query = '', text = '', imported = [] }) {
    if (running) stop();
    slice().text = text;
    slice().imported = imported;
    if (rank) slice().query = query;
    slice().run = null;
    itemsBox.value = text;
    if (queryBox) queryBox.value = query;
    renderCount();
    emptyResults();
    say('');
    persistNow();
  }

  return { start, reset, load, hasWork, refresh, flush, isRunning: () => running, stop };
}
