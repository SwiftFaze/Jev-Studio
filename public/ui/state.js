import { TEMPLATES, TYPE_EXAMPLES } from '../templates.js';
import { draftFromRequest, migrateDraft } from '../request.js';
import { addUsage, emptyUsage } from '../lib/usage.js';
import { emptyGroupTally, emptyTally, mergeGroupTallies, mergeTallies, STEAM_BATCH_SIZES, STEAM_GROUP_SIZES, STEAM_QUESTION_IDS, STEAM_SORTS } from '../lib/steam.js';

// Pages where you write questions. `custom` is the page labelled "Single" in the UI: it takes any question type.
// The others are locked to one type each.
export const PAGE_TYPE = { yesno: 'noul', score: 'score', choice: 'choice' };
export const PAGES = ['custom', 'yesno', 'score', 'choice'];
export const MODES = [...PAGES, 'batch', 'rank', 'steam', 'compare'];

// A saved question set is a page of its own, addressed as `set:<id>`.
export const isSetMode = (mode) => typeof mode === 'string' && mode.startsWith('set:');
export const setIdOf = (mode) => mode.slice('set:'.length);

// A saved Steam analysis is a page of its own too, addressed as `steamsaved:<id>`.
export const isSteamSavedMode = (mode) => typeof mode === 'string' && mode.startsWith('steamsaved:');
export const steamSavedIdOf = (mode) => mode.slice('steamsaved:'.length);

const KEYS = {
  draft: 'jev-studio:draft:v1', // the Custom page (and the questions Batch uses)
  typed: 'jev-studio:typed:v1', // the Yes / No, Score and Choice pages
  history: 'jev-studio:history:v1',
  sets: 'jev-studio:sets:v1',
  setInputs: 'jev-studio:setinputs:v1', // the context you last pasted on each set's page
  setsMenu: 'jev-studio:setsmenu:v1', // whether the sidebar's Question sets submenu is open
  steamMenu: 'jev-studio:steammenu:v1', // whether the saved analyses under Steam reviews in the sidebar are shown
  batch: 'jev-studio:batch:v1',
  rank: 'jev-studio:rank:v1',
  steam: 'jev-studio:steam:v3', // v1 kept every review of one sample, v2 counted six topics; v3 counts each option of twenty, a different shape
  steamSaved: 'jev-studio:steamsaved:v1', // analyses saved from the Steam page: counts and where to carry on, not reviews
  mode: 'jev-studio:mode:v1',
};
const TOKENS_KEY = 'jev-studio:tokens:v1'; // per tab (sessionStorage): a running total for this visit

const storageFor = (kind) => (kind === 'session' ? sessionStorage : localStorage);

// Storage can be unavailable or throw (private windows, blocked storage, quota); the app must work without it.
export function readStore(key, fallback, kind = 'local') {
  try {
    return JSON.parse(storageFor(kind).getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStore(key, value, kind = 'local') {
  try {
    storageFor(kind).setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Big results may not fit the storage quota; if so, keep the inputs and drop only the run. */
function writeWithRun(key, value) {
  if (!writeStore(key, value)) writeStore(key, { ...value, run: null });
}

/** A run that was mid-flight when the page closed has nothing running any more: mark those rows pending. */
function normalizeRun(run) {
  if (!run || !Array.isArray(run.rows)) return null;
  for (const row of run.rows) if (row.status === 'running') row.status = 'pending';
  return run;
}

/** A typed page's draft: whatever was saved, else its first example. Every question is forced to the page's type. */
function typedDraft(page, stored) {
  const draft = Array.isArray(stored?.questions) ? stored : draftFromRequest(TYPE_EXAMPLES[page][0].request);
  if (typeof draft.stateText !== 'string') draft.stateText = '';
  for (const q of draft.questions) q.type = PAGE_TYPE[page];
  return draft;
}

const storedDraft = readStore(KEYS.draft, null);
const customDraft = Array.isArray(storedDraft?.questions) ? migrateDraft(storedDraft) : draftFromRequest(TEMPLATES[0].request);
if (typeof customDraft.stateText !== 'string') customDraft.stateText = '';

const storedTyped = readStore(KEYS.typed, {});

/**
 * Batch's own questions. Before it had its own it ran Single's, so the first time we start from a copy of those; after
 * that the two are independent and saving on Batch saves Batch's questions.
 */
function batchDraft(stored) {
  if (Array.isArray(stored?.questions)) return { stateText: '', questions: stored.questions };
  return { stateText: '', questions: customDraft.questions.map((q) => ({ ...structuredClone(q), uid: `${q.uid}-b` })) };
}
const storedBatch = readStore(KEYS.batch, {});
const storedRank = readStore(KEYS.rank, {});
const storedSteam = readStore(KEYS.steam, {});
const storedSteamSaved = (() => {
  const stored = readStore(KEYS.steamSaved, []);
  return (Array.isArray(stored) ? stored : []).filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string').map((s) => ({ ...s, tally: mergeTallies(emptyTally(), s.tally), gtally: mergeGroupTallies(emptyGroupTally(), s.gtally), ...(s.total ? { total: mergeTallies(emptyTally(), s.total) } : {}), ...(s.gtotal ? { gtotal: mergeGroupTallies(emptyGroupTally(), s.gtotal) } : {}), hasRun: s.hasRun === true }));
})();

/** The Steam page's saved state, with anything missing or no longer valid put back to its default. */
function steamSlice(stored) {
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  return {
    url: typeof stored.url === 'string' ? stored.url : '',
    count: pick(stored.count, STEAM_BATCH_SIZES, 100), // the batch size
    sort: pick(stored.sort, Object.keys(STEAM_SORTS), 'recent'),
    concurrency: pick(stored.concurrency, [1, 2, 3, 4, 5, 6], 3),
    game: stored.game ?? null,
    summary: stored.summary ?? null,
    key: typeof stored.key === 'string' ? stored.key : null,
    cursor: typeof stored.cursor === 'string' ? stored.cursor : '*',
    exhausted: stored.exhausted === true,
    batches: Number.isInteger(stored.batches) ? stored.batches : 0,
    tally: mergeTallies(emptyTally(), stored.tally),
    // Which questions are on (all, by default), and whether reviews are read in groups (cheaper, and only estimates) and how many to a group.
    topics: Array.isArray(stored.topics) ? stored.topics.filter((id) => STEAM_QUESTION_IDS.includes(id)) : [...STEAM_QUESTION_IDS],
    grouped: stored.grouped === true,
    groupSize: pick(stored.groupSize, STEAM_GROUP_SIZES, 50),
    gtally: mergeGroupTallies(emptyGroupTally(), stored.gtally), // the same counts for reviews analysed in groups, for the batches before this one
    savedId: typeof stored.savedId === 'string' ? stored.savedId : null, // the saved analysis this one was carried on from, so saving again offers to overwrite it
    tellThumbs: stored.tellThumbs === true, // off: Jev reads the review without knowing the reviewer's thumbs (see buildSteamState)
    batchOpen: stored.batchOpen !== false, // "This batch" starts open; the table below it starts closed
    tableOpen: stored.tableOpen === true,
    run: normalizeRun(stored.run),
  };
}

const storedSets = readStore(KEYS.sets, []);
// A saved mode that is no longer a page (or a set that has since been deleted) falls back to the first page.
const storedMode = readStore(KEYS.mode, 'custom');
const modeStillExists =
  MODES.includes(storedMode) ||
  (isSetMode(storedMode) && storedSets.some((s) => s.id === setIdOf(storedMode))) ||
  (isSteamSavedMode(storedMode) && storedSteamSaved.some((s) => s.id === steamSavedIdOf(storedMode)));

export const app = {
  mode: modeStillExists ? storedMode : 'custom',
  drafts: {
    custom: customDraft,
    yesno: typedDraft('yesno', storedTyped.yesno),
    score: typedDraft('score', storedTyped.score),
    choice: typedDraft('choice', storedTyped.choice),
    batch: batchDraft(storedTyped.batch),
  },
  // Batch and older code use `app.draft`: it is the Custom page's draft.
  get draft() {
    return this.drafts.custom;
  },
  set draft(value) {
    this.drafts.custom = value;
  },
  history: readStore(KEYS.history, []),
  sets: storedSets,
  setInputs: readStore(KEYS.setInputs, {}),
  setsMenuOpen: readStore(KEYS.setsMenu, true),
  steamMenuOpen: readStore(KEYS.steamMenu, true),
  batch: { text: '', imported: [], concurrency: 3, ...storedBatch, run: normalizeRun(storedBatch.run) },
  rank: { query: '', text: '', concurrency: 3, ...storedRank, run: normalizeRun(storedRank.run) },
  // The Steam page. Reviews are read and analysed one batch at a time, each starting where the last stopped, so a game
  // with hundreds of thousands of them is never held all at once. What is kept: `run` (the current batch, with its rows),
  // `tally` (counts for every earlier batch, which is all the summary needs), and `cursor` (where the next batch starts).
  // `key` says which game and sort those belong to, so changing one starts over; `summary` is Steam's own totals for
  // the game; `batches` counts the ones read, including the current one.
  steam: steamSlice(storedSteam),
  steamSaved: storedSteamSaved,
  tokens: { ...emptyUsage(), ...readStore(TOKENS_KEY, {}, 'session') },
  status: { configured: false, mock: false, keySource: 'none' },
};

export const save = {
  draft: () => writeStore(KEYS.draft, app.drafts.custom),
  typed: () => writeStore(KEYS.typed, { yesno: app.drafts.yesno, score: app.drafts.score, choice: app.drafts.choice, batch: app.drafts.batch }),
  page: (page) => (page === 'custom' ? save.draft() : save.typed()),
  history: () => writeStore(KEYS.history, app.history),
  sets: () => writeStore(KEYS.sets, app.sets),
  setInputs: () => writeStore(KEYS.setInputs, app.setInputs),
  setsMenu: () => writeStore(KEYS.setsMenu, app.setsMenuOpen),
  steamMenu: () => writeStore(KEYS.steamMenu, app.steamMenuOpen),
  mode: () => writeStore(KEYS.mode, app.mode),
  batch: () => writeWithRun(KEYS.batch, app.batch),
  rank: () => writeWithRun(KEYS.rank, app.rank),
  steam: () => writeWithRun(KEYS.steam, app.steam),
  steamSaved: () => writeStore(KEYS.steamSaved, app.steamSaved), // false when the browser has no room
};

const tokenListeners = new Set();
export const onTokens = (fn) => tokenListeners.add(fn);

/** Called for every successful request, whichever mode made it. */
export function recordUsage(usage) {
  app.tokens = addUsage(app.tokens, usage);
  writeStore(TOKENS_KEY, app.tokens, 'session');
  for (const fn of tokenListeners) fn(app.tokens);
}

/** The page whose questions are on screen: a question page or Batch; on any other page, Single's. */
export const currentPage = () => (PAGES.includes(app.mode) || app.mode === 'batch' ? app.mode : 'custom');
export const currentDraft = () => app.drafts[currentPage()];
/** The question type the current page is locked to, or null on Single and Batch. */
export const lockedType = () => PAGE_TYPE[app.mode] ?? null;

export const hasQuestionWork = (draft = currentDraft()) => draft.questions.some((q) => q.instructions.trim() !== '');
