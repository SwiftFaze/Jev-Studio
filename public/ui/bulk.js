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

/** Batch mode (many items, your questions) and Rank mode (many candidates, fixed relevance questions) share this controller. */
export function initBulk(kind, { openCsv } = {}) {
  const rank = kind === 'rank';
  const slice = app[kind];
  const $ = (suffix) => document.querySelector(`#${kind}-${suffix}`);

  let handle = null;
  let running = false;
  let controller = null;
  let refreshTimer = null;
  let saveTimer = null;

  const persistSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save[kind](), 400);
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
  const countEl = h('span', { class: 'muted small' });

  function currentItems() {
    const parsed = parseItems(slice.text);
    return { ...parsed, items: applyExpected(parsed.items, slice.imported) };
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
    placeholder: rank ? 'One candidate per line, such as document titles, answers, or product names.' : 'One item per line. Every item is judged against the same questions below.',
    value: slice.text,
    oninput: (e) => {
      slice.text = e.target.value;
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
        value: slice.query,
        oninput: (e) => {
          slice.query = e.target.value;
          persistSoon();
        },
      })
    : null;

  const fileInput = rank
    ? null
    : h('input', {
        type: 'file',
        id: 'batch-file',
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
              questionIds: app.drafts.batch.questions.map((q) => q.id.trim()).filter(Boolean),
              onImport: ({ items, truncated, total }) => {
                slice.text = items.map((i) => i.text).join('\n');
                slice.imported = items;
                itemsBox.value = slice.text;
                renderCount();
                save.batch();
                say(truncated ? `Imported the first ${MAX_ITEMS} of ${total} rows.` : `Imported ${items.length} rows.`);
              },
            });
          } else {
            slice.text = text;
            slice.imported = [];
            itemsBox.value = text;
            renderCount();
            save.batch();
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
        slice.concurrency = Number(e.target.value);
        save[kind]();
      },
    },
    [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n) }, String(n))),
  );
  concurrency.value = String(slice.concurrency);

  document.querySelector(`#mode-${kind}`).replaceChildren(
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, rank ? '1. What are you looking for?' : '1. What should Jev look at?')),
      rank ? [queryBox, h('h3', {}, 'Candidates'), h('p', { class: 'hint' }, 'Jev scores how well each candidate answers the query, then they are ranked by a weighted score. Nothing is generated: you get probabilities.')] : h('p', { class: 'hint' }, 'One item per line. Each is judged on its own against the questions below, one request per item.'),
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
    const run = slice.run;
    controller = new AbortController();
    running = true;
    syncButtons();
    handle?.refresh();

    const { fatal } = await executeBatch({
      rows: run.rows,
      indices,
      concurrency: slice.concurrency,
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
    save[kind]();
  }

  function show() {
    handle = renderBatchResults($('results'), slice.run, {
      onChange: persistSoon,
      onStop: stop,
      onResume: () => execute(slice.run.rows.flatMap((r, i) => (r.status === 'ok' ? [] : [i]))),
      onRetryRow: (i) => !running && execute([i]),
      isRunning: () => running,
    });
  }

  function emptyResults() {
    handle = null;
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

    if (rank && !slice.query.trim()) return say('Enter what you are looking for first.');
    if (items.length === 0) return say(rank ? 'Add at least one candidate.' : 'Add at least one item.');

    let questions;
    try {
      questions = rank ? rankQuestions() : buildQuestions(app.drafts.batch.questions);
    } catch (err) {
      return say(err.message);
    }
    if (Object.keys(questions).length === 0) return say('Add at least one question.');
    if (!app.status.mock && items.length > CONFIRM_ABOVE && !confirm(`This will make ${items.length} API calls with your key. Continue?`)) return;

    say('');
    const previous = slice.run;
    slice.run = {
      kind,
      questions,
      model: DEFAULT_MODEL,
      query: rank ? slice.query.trim() : undefined,
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
    await execute(slice.run.rows.map((_, i) => i));
  }

  /**
   * New query: start over. Clears the items (or the query and candidates), the results, and, for Batch, Batch's own
   * questions. Rank's questions are fixed, so there is nothing to clear there.
   */
  function reset() {
    if (running) stop();
    const questionsAtStake = !rank && hasQuestionWork(app.drafts.batch);
    const resultsAtStake = slice.run?.rows.some((r) => r.status === 'ok');
    if ((questionsAtStake || resultsAtStake) && !confirm(`Start a new query? This clears the ${rank ? 'query, the candidates' : 'items'}${questionsAtStake ? ', the questions' : ''} and the results. Batch and rank results are not kept in History.`)) return;
    if (!rank) {
      app.drafts.batch = { stateText: '', questions: blankDraft().questions };
      save.typed();
      renderBuilder();
    }
    slice.text = '';
    slice.imported = [];
    if (rank) slice.query = '';
    slice.run = null;
    itemsBox.value = '';
    if (queryBox) queryBox.value = '';
    renderCount();
    emptyResults();
    say('');
    save[kind]();
    (queryBox ?? itemsBox).focus();
  }

  // replaceChildren (unlike h) would print a `false` child as the text "false", so build the list without it.
  document.querySelector(`#runbar-${kind}`).replaceChildren(
    ...[
      runBtn,
      stopBtn,
      // Batch runs Single's questions, so it can save them as a set; Rank's questions are fixed.
      !rank && h('button', { type: 'button', id: 'save-batch', class: 'btn', onclick: openSaveSet, title: 'Save the questions as a question set, or overwrite one' }, 'Save'),
      statusEl,
    ].filter(Boolean),
  );

  renderCount();
  if (slice.run) show();
  else emptyResults();
  syncButtons();

  /** Is there anything here that loading an example would throw away? */
  const hasWork = () => slice.text.trim() !== '' || (rank && slice.query.trim() !== '') || Boolean(slice.run?.rows.some((r) => r.status === 'ok'));

  /** Replace the input with an example (or blank) and clear the results. */
  function load({ query = '', text = '', imported = [] }) {
    if (running) stop();
    slice.text = text;
    slice.imported = imported;
    if (rank) slice.query = query;
    slice.run = null;
    itemsBox.value = text;
    if (queryBox) queryBox.value = query;
    renderCount();
    emptyResults();
    say('');
    save[kind]();
  }

  return { start, reset, load, hasWork };
}
