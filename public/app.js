import { h } from './dom.js';
import { BATCH_EXAMPLES, RANK_EXAMPLES, STEAM_EXAMPLES, TEMPLATES, TYPE_EXAMPLES, WIKIPEDIA_EXAMPLES } from './templates.js';
import { draftFromRequest, questionsFromApi, stateToText } from './request.js';
import { app, hasQuestionWork, isSetMode, isSteamSavedMode, isWikipediaSavedMode, MODES, onTokens, PAGES, PAGE_TYPE, save, setIdOf, steamSavedIdOf, wikipediaSavedIdOf } from './ui/state.js';
import { initBuilder, renderBuilder, setBuilderPage } from './ui/builder.js';
import { createWorkspace } from './ui/workspace.js';
import { createSetPage } from './ui/setpage.js';
import { initBulk } from './ui/bulk.js';
import { initSteam } from './ui/steam.js';
import { initWikipedia } from './ui/wikipedia.js';
import { createWikipediaSavedPage, renderWikipediaSavedMenu, toggleWikipediaSavedMenu } from './ui/wikipedia-saved.js';
import { createSteamSavedPage, renderSteamSavedMenu, toggleSteamSavedMenu } from './ui/steam-saved.js';
import { getBatch } from './ui/idb.js';
import { fieldsFromSaved } from './lib/steam.js';
import { initCompare, openCompare, refreshCompare } from './ui/compare.js';
import { initDialogs, openCsvDialog } from './ui/dialogs.js';
import { closeMenu, initSidebar, renderSetsMenu } from './ui/sidebar.js';
import { initSaveSet, flash } from './ui/save-set.js';
import { describeKeySource, initApiKey, migrateLegacyKey, openApiKey } from './ui/apikey.js';
import { fetchStatus } from './ui/api.js';
import { formatTokens } from './lib/usage.js';
import { editPageOf } from './lib/library.js';

const $ = (selector) => document.querySelector(selector);
const workspaces = {}; // one per question page: custom, yesno, score, choice
const bulk = {};
let setPage = null; // the page that serves every saved question set
let steamSavedPage = null; // the page that serves every saved Steam analysis
let wikipediaSavedPage = null; // the page that serves every saved Wikipedia answer
let newQueryFor = {}; // which containers a mode uses -> its "New query" action
let measureBars = null;

/** Every saved set shares one set of containers (`mode-set`, `pane-set`, `runbar-set`); so does every saved Steam analysis, and every saved Wikipedia answer. */
const keyOf = (mode) => (isSetMode(mode) ? 'set' : isSteamSavedMode(mode) ? 'steamsaved' : isWikipediaSavedMode(mode) ? 'wikipediasaved' : mode);
const CONTAINER_KEYS = [...MODES, 'set', 'steamsaved', 'wikipediasaved'];

/**
 * The header and the bottom bar are pinned, so tell the CSS how tall they are: scroll targets and keyboard focus
 * then stay clear of them.
 */
function trackBars() {
  const root = document.documentElement.style;
  const header = $('.mainbar');
  const dock = $('#dock');
  const measure = () => {
    root.setProperty('--topbar-h', `${Math.ceil(header.getBoundingClientRect().height)}px`);
    root.setProperty('--dock-h', dock.hidden ? '0px' : `${Math.ceil(dock.getBoundingClientRect().height)}px`);
  };
  const observer = new ResizeObserver(measure);
  observer.observe(header);
  observer.observe(dock);
  window.addEventListener('resize', measure);
  measure();
  return measure;
}

/* ---------- pages ---------- */

function setMode(mode) {
  // A set saved from Batch has no single-context page of its own to run on (its questions are meant to run against
  // many rows, not one pasted block of context) — opening one edits it on Batch instead, the same as "Edit in Batch"
  // already does, rather than showing it on the single-context set page as if it were any other set.
  if (isSetMode(mode)) {
    const set = app.sets.find((s) => s.id === setIdOf(mode));
    if (set && editPageOf(set) === 'batch') return editSet(set.id);
  }
  const known = isSetMode(mode)
    ? app.sets.some((s) => s.id === setIdOf(mode))
    : isSteamSavedMode(mode)
      ? app.steamSaved.some((a) => a.id === steamSavedIdOf(mode))
      : isWikipediaSavedMode(mode)
        ? app.wikipedia.saved.some((a) => a.id === wikipediaSavedIdOf(mode))
        : MODES.includes(mode);
  if (!known) mode = 'custom';
  app.mode = mode;
  save.mode();

  const key = keyOf(mode);
  const isPage = PAGES.includes(mode);
  const isSet = key === 'set';
  const isSteamSaved = key === 'steamsaved';
  const isWikipediaSaved = key === 'wikipediasaved';

  for (const k of CONTAINER_KEYS) {
    $(`#mode-${k}`).hidden = k !== key;
    $(`#pane-${k}`).hidden = k !== key;
    const runbar = $(`#runbar-${k}`);
    if (runbar) runbar.hidden = k !== key;
  }
  // The question builder serves the four question pages and Batch, each with its own questions. A saved set's
  // questions are deliberately not shown.
  $('#builder-panel').hidden = !isPage && mode !== 'batch';
  if (isPage || mode === 'batch') setBuilderPage(mode);
  if (isSet) setPage.open(setIdOf(mode));
  if (isSteamSaved) steamSavedPage.open(steamSavedIdOf(mode));
  if (isWikipediaSaved) wikipediaSavedPage.open(wikipediaSavedIdOf(mode));

  // How the page is laid out and in what order (see the CSS): questions / input / answers, input / questions / results, ...
  const kind = isPage ? 'page' : isSet ? 'set' : mode === 'compare' || isSteamSaved || isWikipediaSaved ? 'compare' : 'bulk';
  $('#layout').dataset.kind = kind;

  // Controls that do not apply are made invisible rather than removed, so nothing else on screen moves.
  $('#new-query').classList.toggle('ghosted', !newQueryFor[key]);
  $('#dock').hidden = !$(`#runbar-${key}`);
  renderExampleMenu(mode);

  for (const btn of document.querySelectorAll('[data-mode]')) btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  if (mode === 'compare') refreshCompare();
  closeMenu();
  measureBars?.();
}

/** Replace one question page's input and questions, and clear its answers. */
function loadPageDraft(page, next) {
  if (PAGE_TYPE[page]) for (const q of next.questions) q.type = PAGE_TYPE[page];
  app.drafts[page] = next;
  save.page(page);
  workspaces[page]?.renderState(); // Batch has questions but no context box of its own
  if (app.mode === page) renderBuilder();
  workspaces[page]?.resetResults();
}

/** A run goes back to the page it was made on. Runs saved before the question pages existed belong to Single. */
function restoreRun(entry) {
  if (entry.page === 'set' && app.sets.some((s) => s.id === entry.setId)) {
    app.setInputs[entry.setId] = stateToText(entry.request.state);
    save.setInputs();
    setMode(`set:${entry.setId}`);
    setPage.showRun(entry);
    return;
  }
  const page = workspaces[entry.page] ? entry.page : 'custom';
  loadPageDraft(page, draftFromRequest(entry.request));
  setMode(page);
  workspaces[page].showRun(entry);
}

/* ---------- saved Steam analyses ---------- */

/** Continue analysis: put a saved analysis back on the Steam reviews page, where it carries on from where it stopped. */
async function continueSteam(saved) {
  if (bulk.steam.hasWork() && !confirm('Replace what is on the Steam reviews page with this saved analysis?')) return;
  const run = saved.hasRun ? await getBatch(saved.id).catch(() => null) : null; // its batch of reviews is kept in the browser's database
  bulk.steam.restore({ ...fieldsFromSaved(saved, run), savedId: saved.id });
  setMode('steam');
  if (saved.hasRun && !run) flash('The saved reviews could not be read, so the table is empty. The counts are kept.');
}

/* ---------- question sets ---------- */

/** The saved sets changed (saved, imported, deleted): refresh the menu, and leave a set page whose set is gone. */
function onSetsChanged() {
  renderSetsMenu();
  if (isSetMode(app.mode) && !app.sets.some((s) => s.id === setIdOf(app.mode))) setMode('custom');
}

/** Put a set's questions on the page it is edited on (Batch for sets saved there, else Single). Keeps that page's input. */
function editSet(id) {
  const set = app.sets.find((s) => s.id === id);
  if (!set) return;
  const page = editPageOf(set);
  loadPageDraft(page, { stateText: app.drafts[page].stateText, questions: questionsFromApi(set.questions), setId: id });
  setMode(page);
}

/* ---------- examples ---------- */

const examplesFor = (mode) => (mode === 'custom' ? TEMPLATES : mode === 'rank' ? RANK_EXAMPLES : mode === 'batch' ? BATCH_EXAMPLES : mode === 'steam' ? STEAM_EXAMPLES : mode === 'wikipedia' ? WIKIPEDIA_EXAMPLES : (TYPE_EXAMPLES[mode] ?? []));
const hasExamples = (mode) => PAGES.includes(mode) || mode === 'rank' || mode === 'batch' || mode === 'steam' || mode === 'wikipedia';

function renderExampleMenu(mode) {
  const select = $('#template');
  select.classList.toggle('ghosted', !hasExamples(mode));
  select.replaceChildren(
    h('option', { value: '' }, 'Load an example…'),
    ...examplesFor(mode).map((t, i) => h('option', { value: String(i) }, t.name)),
  );
}

function setupExamples() {
  const select = $('#template');
  select.addEventListener('change', () => {
    const value = select.value;
    select.value = '';
    const page = app.mode;
    if (!value) return;
    if (page === 'rank') {
      if (bulk.rank.hasWork() && !confirm('Replace the current query, candidates and results?')) return;
      const example = RANK_EXAMPLES[Number(value)];
      bulk.rank.load({ query: example.query, text: example.candidates.join('\n') });
      return;
    }
    if (page === 'steam') {
      if (bulk.steam.hasWork() && !confirm('Replace the current link, reviews and results?')) return;
      bulk.steam.load({ url: STEAM_EXAMPLES[Number(value)].url });
      return;
    }
    if (page === 'wikipedia') {
      if (bulk.wikipedia.hasWork() && !confirm('Replace the current question and answer?')) return;
      bulk.wikipedia.load({ question: WIKIPEDIA_EXAMPLES[Number(value)].question });
      return;
    }
    if (page === 'batch') {
      // An example brings its questions too, into Batch's own set of questions.
      if ((bulk.batch.hasWork() || hasQuestionWork(app.drafts.batch)) && !confirm('Replace the current items, results and questions?')) return;
      const example = BATCH_EXAMPLES[Number(value)];
      loadPageDraft('batch', { stateText: '', questions: questionsFromApi(example.questions) });
      bulk.batch.load({ text: example.items.map((i) => i.text).join('\n'), imported: example.items });
      return;
    }
    if (!PAGES.includes(page)) return;
    const hasWork = app.drafts[page].stateText.trim() !== '' || hasQuestionWork(app.drafts[page]);
    if (hasWork && !confirm('Replace the current input and questions?')) return;
    loadPageDraft(page, draftFromRequest(examplesFor(page)[Number(value)].request));
  });
}

/* ---------- status and tokens ---------- */

let serverState = 'checking'; // 'checking' | 'ready' | 'offline'

/** The pill and the banner: whether the server has a key (saved in the app, or from the environment). */
function renderStatus() {
  const pill = $('#status-pill');
  const banner = $('#banner');
  banner.hidden = true;
  pill.title = '';
  if (serverState === 'checking') return;
  if (serverState === 'offline') {
    pill.textContent = 'Server offline';
    pill.className = 'pill pill-bad';
    return;
  }
  if (app.status.mock) {
    pill.textContent = 'Mock data';
    pill.className = 'pill pill-warn';
  } else if (app.status.configured) {
    pill.textContent = 'Connected';
    pill.className = 'pill pill-good';
    pill.title = describeKeySource(app.status);
  } else {
    pill.textContent = 'No API key';
    pill.className = 'pill pill-bad';
    banner.hidden = false;
    banner.replaceChildren(
      app.status.keyUnreadable ? 'The saved API key cannot be read on this computer. ' : 'No API key yet. ',
      h('button', { type: 'button', id: 'banner-add-key', class: 'btn btn-sm', onclick: openApiKey }, 'Add your API key'),
      ' to get started, or start the app with ',
      h('code', {}, '--mock'),
      ' to explore with sample data.',
    );
  }
  measureBars?.();
}

async function loadStatus() {
  try {
    Object.assign(app.status, await fetchStatus());
    serverState = 'ready';
  } catch {
    serverState = 'offline';
  }
  renderStatus();
}

function setupTokenChip() {
  const chip = $('#token-chip');
  const update = (t) => {
    chip.textContent = formatTokens(t);
    chip.title = `This tab so far: ${t.calls} request${t.calls === 1 ? '' : 's'}, ${t.input.toLocaleString('en-US')} input + ${t.output.toLocaleString('en-US')} output tokens`;
  };
  onTokens(update);
  update(app.tokens);
}

/* ---------- start ---------- */

const openComparison = (previous, latest) => {
  setMode('compare');
  openCompare(previous, latest);
};
for (const page of PAGES) workspaces[page] = createWorkspace(page, { onCompare: openComparison });
setPage = createSetPage({ onCompare: openComparison });
steamSavedPage = createSteamSavedPage({ onContinue: continueSteam, onDeleted: () => setMode('steam') });
renderSteamSavedMenu();
document.querySelector('#steam-toggle').addEventListener('click', toggleSteamSavedMenu);
// A saved Wikipedia answer is a page of its own: Ask again goes to the Wikipedia answer page with its question, and Remove goes back there too.
wikipediaSavedPage = createWikipediaSavedPage({
  onAskAgain: (question) => {
    setMode('wikipedia');
    bulk.wikipedia.load({ question });
  },
  onRemoved: () => setMode('wikipedia'),
  openInSingle: restoreRun,
});
renderWikipediaSavedMenu();
document.querySelector('#wikipedia-toggle').addEventListener('click', toggleWikipediaSavedMenu);
initBuilder();
bulk.batch = initBulk('batch', { openCsv: openCsvDialog });
bulk.rank = initBulk('rank');
bulk.steam = initSteam();
bulk.wikipedia = initWikipedia({ openInSingle: restoreRun });
initCompare();
initSidebar({ onNavigate: setMode });
initSaveSet({ onSetsChanged });
initDialogs({
  restoreRun,
  onHistoryChanged: refreshCompare,
  onSetsChanged,
  editSet,
  openSet: (id) => setMode(`set:${id}`),
});
setupExamples();
setupTokenChip();
initApiKey({
  getStatus: () => app.status,
  onChanged: (status, message) => {
    Object.assign(app.status, status);
    renderStatus();
    flash(message);
  },
});

// What "New query" does on each kind of page; Compare has nothing to clear.
newQueryFor = { batch: () => bulk.batch.reset(), rank: () => bulk.rank.reset(), steam: () => bulk.steam.reset(), wikipedia: () => bulk.wikipedia.reset(), set: () => setPage.newQuery() };
for (const page of PAGES) newQueryFor[page] = workspaces[page].newQuery;
$('#new-query').addEventListener('click', () => newQueryFor[keyOf(app.mode)]?.());

const runners = { batch: () => bulk.batch.start(), rank: () => bulk.rank.start(), steam: () => bulk.steam.start(), wikipedia: () => bulk.wikipedia.start(), set: () => setPage.run() };
for (const page of PAGES) runners[page] = workspaces[page].run;
document.addEventListener('keydown', (e) => {
  const run = runners[keyOf(app.mode)];
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && run) {
    e.preventDefault();
    run();
  }
});

measureBars = trackBars();
setMode(app.mode);
loadStatus().then(async () => {
  // A key saved by an earlier version lives in this browser's storage; move it into the app's encrypted store.
  const migrated = await migrateLegacyKey();
  if (migrated) {
    Object.assign(app.status, migrated);
    renderStatus();
    flash('Your saved API key was moved into the app and is now stored encrypted.');
  }
});
