import { h } from '../dom.js';
import { app, save } from './state.js';
import { executeBatch } from '../lib/batch.js';
import { DEFAULT_MODEL } from '../request.js';
import { mergeSpecs } from '../lib/composite.js';
import { DEFAULT_MIN_CERTAINTY } from '../lib/review.js';
import { runProgress } from '../lib/overview.js';
import { batchReplyProblem, buildSteamState, describeSteamReview, emptyTally, expectedFor, mergeTallies, moreSlider, parseSteamApp, reviewsFor, roughDuration, roughTokens, steamFilter, steamFilterChoices, steamQuestions, steamSpecs, STEAM_BATCH_SIZES, STEAM_SORTS, storeUrl, tallyRows, TOKENS_PER_REVIEW } from '../lib/steam.js';
import { pct } from '../results.js';
import { postRun, postSteamReviews } from './api.js';
import { renderBatchResults } from './batch-results.js';
import { renderSteamVerdict } from './steam-verdict.js';
import { openSaveSteam } from './steam-saved.js';
import { revealPane } from './reveal.js';

const CONFIRM_ABOVE = 20; // ask before spending this many live API calls at once
const PAGE_SIZE = 25; // reviews per page in the table
const MEASURED_AFTER = 20; // reviews read before the token estimate uses what they actually cost
const LOOKUP_DELAY_MS = 500; // wait for typing to stop before asking Steam how many reviews there are
const EXAMPLE_LINK = 'https://store.steampowered.com/app/548430/Deep_Rock_Galactic/';
const number = (n) => n.toLocaleString('en-US');

/**
 * The Steam page: paste a game's store link and Jev answers the same questions about its reviews.
 *
 * A game can have hundreds of thousands of reviews, so they are never all loaded at once. They are read from Steam one
 * batch at a time, each starting where the last stopped, and analysed as they arrive on the batch engine (one request
 * per review, so stop, resume, review flags, sorting and CSV export work as they do on Batch). A finished batch is
 * reduced to counts and its rows are let go; the summary adds those up across every batch, while the table, overview
 * and settings cover the batch you are on. "Analyse all" keeps going batch after batch until you stop it or Steam runs
 * out, and the next press carries on from where it stopped.
 */
export function initSteam() {
  const slice = app.steam;
  const $ = (suffix) => document.querySelector(`#steam-${suffix}`);

  let handle = null;
  let running = false; // an analysis is under way: reading a batch from Steam, or asking Jev about its reviews
  let phase = 'idle'; // while running: 'fetching' a batch from Steam, or 'analysing' it
  let controller = null;
  let lookupTimer = null;
  let lookupController = null;
  let refreshTimer = null;
  let saveTimer = null;

  const persistSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save.steam(), 400);
  };
  // Row updates arrive in bursts; redraw at most ~5 times a second.
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

  /* ---------- what there is so far ---------- */
  /** Which game and sort the progress belongs to. Changing either means starting over. */
  const keyOf = () => {
    const game = parseSteamApp(slice.url);
    return game ? `${game.appId}|${slice.sort}` : null;
  };
  const onThisGame = () => slice.key != null && slice.key === keyOf();
  /** Counts for every review read so far: the finished batches, plus the one on screen. */
  const totalTally = () => mergeTallies(slice.tally, slice.run ? tallyRows(slice.run.rows) : null);
  /** Is there a batch on screen that still has reviews to ask Jev about? (Failed ones are for "Resume / retry failed".) */
  const unfinished = () => Boolean(slice.run?.rows.some((r) => r.status !== 'ok' && r.status !== 'error'));
  const hasProgress = () => slice.batches > 0;
  /**
   * What one review costs in tokens: what the reviews read so far actually cost, once there are enough to go on, and the
   * built-in guess until then. The questions are the bulk of it, so this changes if they do.
   */
  const perReview = () => {
    const { answered, tokens } = totalTally();
    return answered >= MEASURED_AFTER ? tokens / answered : TOKENS_PER_REVIEW;
  };
  const tokensFor = (reviews) => roughTokens(reviews * perReview());

  /* ---------- input panel ---------- */
  const gameEl = h('p', { id: 'steam-game', class: 'small muted', role: 'status' });
  const progressEl = h('p', { id: 'steam-progress', class: 'small' });
  const costEl = h('p', { class: 'hint' });

  function renderGame() {
    const game = parseSteamApp(slice.url);
    if (!slice.url.trim()) return gameEl.replaceChildren();
    if (!game) return gameEl.replaceChildren("That is not a Steam game link. Paste the address of the game's store page.");
    gameEl.replaceChildren(`${game.name ?? 'Steam app'} · app ${game.appId} · `, h('a', { href: storeUrl(game.appId), target: '_blank', rel: 'noopener noreferrer' }, 'open on Steam'));
  }

  function renderCost() {
    const total = slice.summary?.totalReviews ?? 0;
    const all = total > 0 ? ` All ${number(total)} would be roughly ${tokensFor(total)} tokens.` : '';
    costEl.textContent = `Jev reads every review separately: each batch of ${slice.count} is ${slice.count} requests, roughly ${tokensFor(slice.count)} tokens, with your key.${all}`;
  }

  /** What Steam says about the game, how far the analysis has got, and a warning if the link or settings have changed under it. */
  function renderProgress() {
    const lines = [];
    const { summary } = slice;
    if (summary?.totalReviews > 0) {
      lines.push(`On Steam: ${summary.scoreDesc || 'no rating'}, ${number(summary.totalPositive)} of ${number(summary.totalReviews)} reviews (all languages) are thumbs up (${pct(summary.totalPositive / summary.totalReviews)}).`);
    }
    if (hasProgress() && onThisGame()) {
      const tally = totalTally();
      const total = summary?.totalReviews ?? 0;
      lines.push(`Analysed ${number(tally.answered)}${total > 0 ? ` of ${number(total)} (${pct(Math.min(1, tally.answered / total))})` : ''} in ${number(slice.batches)} ${slice.batches === 1 ? 'batch' : 'batches'}, ${number(tally.tokens)} tokens so far.${slice.exhausted ? ' That is every review Steam has.' : ' The next batch starts where the last one stopped.'}`);
    } else if (hasProgress()) {
      lines.push('You changed the link or the sort, so the next batch starts over and the totals so far are cleared.');
    }
    progressEl.replaceChildren(...lines.flatMap((line, i) => (i ? [h('br'), line] : [line])));
  }

  const urlBox = h('input', {
    type: 'text',
    id: 'steam-url',
    class: 'text',
    'aria-label': 'Steam store link',
    placeholder: EXAMPLE_LINK,
    autocomplete: 'off',
    spellcheck: false,
    value: slice.url,
    oninput: (e) => {
      slice.url = e.target.value;
      persistSoon();
      renderGame();
      renderProgress();
      scheduleLookup();
    },
    onkeydown: (e) => {
      // Enter only asks Steam how many reviews there are, which is free. Spending your key is what the buttons below are for.
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(lookupTimer);
        lookup();
      }
    },
  });

  /** A labelled menu whose choice is kept on the slice. */
  function setting(name, label, entries, { after = () => {} } = {}) {
    const select = h('select', { id: `steam-${name}`, 'aria-label': label, onchange: (e) => {
      slice[name] = /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value; // a number, or a sort
      persistSoon();
      after();
    } }, entries.map(([value, text]) => h('option', { value: String(value) }, text)));
    select.value = String(slice[name]);
    return h('label', { class: 'small' }, `${label} `, select);
  }
  // A different sort is a different order of reviews, so the progress so far no longer applies.
  const sortChanged = () => renderProgress();

  document.querySelector('#mode-steam').replaceChildren(
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, '1. Which game?')),
      h('p', { class: 'hint' }, "Paste a game's Steam store link. Jev reads its reviews a batch at a time and answers the questions below about each one: is it positive, worth the price, pay to win, does it run badly, and more."),
      urlBox,
      gameEl,
      h(
        'div',
        { class: 'bulk-meta' },
        setting('count', 'Batch size', STEAM_BATCH_SIZES.map((n) => [n, String(n)]), { after: renderCost }),
        setting('sort', 'Show', Object.entries(STEAM_SORTS), { after: sortChanged }),
        h('label', { class: 'small' }, 'Run ', (() => {
          const select = h('select', { id: 'steam-concurrency', 'aria-label': 'Requests at a time', onchange: (e) => { slice.concurrency = Number(e.target.value); save.steam(); } }, [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n) }, String(n))));
          select.value = String(slice.concurrency);
          return select;
        })(), ' at a time'),
      ),
      costEl,
      h(
        'label',
        { class: 'check small', title: 'Off: Jev works out whether the review is positive from what it says. On: Jev is told the reviewer\'s thumbs, so that answer repeats it.' },
        h('input', { type: 'checkbox', id: 'steam-thumbs', checked: slice.tellThumbs, onchange: (e) => { slice.tellThumbs = e.target.checked; persistSoon(); } }),
        " Tell Jev the reviewer's thumbs up or down",
      ),
      h('p', { class: 'hint' }, "Jev is always given how long the reviewer has played, whether they got the game free or refunded it, and how many found the review helpful. Leave the thumbs off and the Positive card and the accuracy check come from what the review says, checked against the thumbs; turn it on and both just repeat them. It applies from the next batch."),
      progressEl,
      h('details', { class: 'explainer' }, h('summary', {}, 'What Jev is asked'), h('ul', {}, Object.entries(steamQuestions()).map(([id, q]) => h('li', {}, h('span', { class: 'mono' }, id), `: ${q.instructions}`)))),
    ),
  );

  /* ---------- asking Steam how many reviews there are ---------- */
  function scheduleLookup() {
    clearTimeout(lookupTimer);
    lookupController?.abort();
    if (running || !parseSteamApp(slice.url)) return;
    lookupTimer = setTimeout(lookup, LOOKUP_DELAY_MS);
  }

  /** One review's worth of request, for the totals Steam sends with the first page. Nothing is analysed and no key is used. */
  async function lookup() {
    const game = parseSteamApp(slice.url);
    const key = keyOf();
    if (!game || running) return;
    lookupController = new AbortController();
    try {
      const data = await postSteamReviews({ app: game.appId, count: 1, sort: slice.sort }, lookupController.signal);
      if (keyOf() !== key || running || !data.summary) return; // the link changed while we waited, or an analysis has its own totals
      slice.summary = data.summary;
      slice.game = { appId: game.appId, name: game.name };
      persistSoon();
      renderCost();
      renderProgress();
      say(data.summary.totalReviews === 0 ? `Steam has no reviews for app ${game.appId}. Check the link.` : '');
    } catch (err) {
      if (err.name === 'AbortError') return;
      say(err.status === 405 ? STALE_SERVER : `Could not ask Steam how many reviews there are: ${err.message}`);
    }
  }
  const STALE_SERVER = 'The running server is older than this page and cannot read Steam reviews. Restart Jev Studio (stop it, then start it again) and try again.';

  /* ---------- running ---------- */
  const runBtn = h('button', { type: 'button', id: 'steam-run', class: 'btn btn-primary', onclick: () => analyse() });
  const moreBtn = h('button', { type: 'button', id: 'steam-more', class: 'btn', title: 'Choose how much of the game to analyse, and see what it will cost first', onclick: () => openMore() }, 'Analyse more…');
  const saveBtn = h('button', { type: 'button', id: 'steam-save', class: 'btn', title: 'Save this analysis under Steam reviews in the menu, to look at or carry on later', onclick: () => openSaveSteam() }, 'Save…');
  const stopBtn = h('button', { type: 'button', id: 'steam-stop', class: 'btn', hidden: true, onclick: () => stop() }, 'Stop');
  const statusEl = h('span', { id: 'steam-status', class: 'runbar-status', role: 'status', hidden: true });

  // The results scroll; the bottom bar does not. A batch takes minutes and "all" takes hours, so its progress lives here.
  const dockFill = h('div', { class: 'bar-fill is-winner' });
  const dockLabel = h('strong', { class: 'dock-progress-label' });
  const dockProgress = h('div', { class: 'dock-progress', role: 'progressbar', 'aria-label': 'Reviews analysed in this batch', hidden: true }, h('div', { class: 'bar bar-big' }, dockFill), dockLabel);

  /** The bar in the bottom bar, shown while an analysis is running: how far the batch on screen has got. */
  function syncProgress() {
    const { total, done, share } = slice.run ? runProgress(slice.run.rows) : { total: 0, done: 0, share: 0 };
    const reading = phase === 'fetching';
    dockProgress.hidden = !running;
    dockFill.style.width = reading ? '0%' : `${share * 100}%`;
    dockLabel.textContent = reading ? 'Reading the next reviews from Steam…' : `Batch ${number(slice.batches)} · ${number(done)} of ${number(total)} · ${Math.round(share * 100)}%`;
    dockProgress.setAttribute('aria-valuenow', String(reading ? 0 : Math.round(share * 100)));
  }

  function syncButtons() {
    runBtn.textContent = unfinished() ? 'Continue this batch' : hasProgress() && onThisGame() ? 'Analyse next batch' : 'Analyse first batch';
    runBtn.disabled = running;
    moreBtn.disabled = running;
    saveBtn.disabled = !hasProgress(); // there is nothing to save until a batch has been read
    stopBtn.hidden = !running;
    syncProgress();
  }

  function stop() {
    controller?.abort();
  }

  const describeRow = (row) => describeSteamReview(row.meta);

  /** The summary of every review read so far, with how much of the game that is. */
  const renderVerdict = () => renderSteamVerdict($('verdict'), hasProgress() ? totalTally() : null, { steamTotal: slice.summary?.totalReviews ?? 0, onPick: pick });

  /**
   * A click on a count on the summary: open the table, scroll to it, and show only the reviews that gave that answer. The
   * table holds the batch on screen and no more (earlier batches were reduced to counts), so when the count covers more
   * than one batch the bar above the table says so.
   */
  function pick(topic, option) {
    if (!slice.run || !handle) return say('The reviews of this batch are not on screen, so there is nothing to filter. Read a batch first.');
    handle.setFilter(steamFilter(topic, option, { batches: slice.batches }));
    const card = $('table-card');
    card.open = true;
    slice.tableOpen = true;
    persistSoon();
    card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function show() {
    const inner = renderBatchResults($('results'), slice.run, {
      pageSize: PAGE_SIZE,
      tableRoot: $('table'),
      onTableHeadline: (text) => { $('table-headline').textContent = text; },
      onProgressHeadline: (text) => { $('batch-headline').textContent = text; },
      groupSettings: true,
      columns: ['positive'], // a column for every question would not fit; open a row to see every answer
      filterChoices: () => steamFilterChoices({ batches: slice.batches, where: 'this one' }),
      hideProgressBar: true, // the bar is pinned in the bottom bar while a run is going; this section keeps the count
      onChange: persistSoon,
      onStop: stop,
      onResume: () => resumeFailed(),
      onRetryRow: (i) => !running && withAction(() => execute([i])),
      isRunning: () => running,
      describeRow,
    });
    // The table's own controls redraw only the table; the summary and the bars change only when answers arrive, which comes through here.
    handle = {
      refresh: () => {
        inner.refresh();
        renderVerdict();
        renderProgress();
        renderCost(); // the estimate follows what the reviews read so far actually cost
        syncProgress();
      },
      setFilter: inner.setFilter,
    };
    renderVerdict();
    renderProgress();
  }

  function emptyResults() {
    handle = null;
    renderVerdict();
    $('results').replaceChildren(
      h('p', { class: 'muted' }, 'This batch appears here as its reviews are read: an overview of the answers, and settings for how uncertain ones are flagged. Nothing is sent to Jev until you press Analyse.'),
      h(
        'details',
        { class: 'explainer' },
        h('summary', {}, 'What you get'),
        h('ul', {}, [
          h('li', {}, h('strong', {}, 'What reviewers say'), ': for each topic, how many reviews mention it and how many are for or against, added up across every batch.'),
          h('li', {}, h('strong', {}, 'Accuracy check'), ": Steam's thumbs up or down is the expected answer for the positive question, so you see how often Jev's reading of the text agrees with it."),
          h('li', {}, h('strong', {}, 'The reviews'), ': every review in the batch with its answers, sortable, with review flags for the ones Jev was unsure about. Export CSV has the batch.'),
        ]),
      ),
    );
    $('table').replaceChildren(h('p', { class: 'muted' }, 'The reviews in the current batch appear here once it has been read.'));
    $('table-headline').textContent = '';
    $('batch-headline').textContent = '';
  }

  /** Ask Jev about these rows of the batch on screen, a few at a time, until they are done or the analysis is stopped. */
  async function execute(indices) {
    const run = slice.run;
    phase = 'analysing';
    syncButtons();
    handle?.refresh();

    const { fatal } = await executeBatch({
      rows: run.rows,
      indices,
      concurrency: slice.concurrency,
      signal: controller.signal,
      requestFor: (row) => ({ state: buildSteamState(run.game?.name, row, { thumbs: run.thumbs }), model: run.model, questions: run.questions }),
      send: postRun,
      onUpdate: scheduleRefresh,
    });

    run.fatal = fatal ? fatal.message : null;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    handle?.refresh();
    save.steam();
  }

  /** Run `work` as the analysis under way: Stop can end it, and nothing else starts until it has. */
  async function withAction(work) {
    clearTimeout(lookupTimer);
    lookupController?.abort();
    controller = new AbortController();
    running = true;
    phase = 'analysing';
    syncButtons();
    try {
      await work();
    } catch (err) {
      if (err.name !== 'AbortError') say(err.status === 405 ? STALE_SERVER : err.message);
    } finally {
      running = false;
      phase = 'idle';
      controller = null;
      syncButtons();
      handle?.refresh();
      save.steam();
    }
  }

  const resumeFailed = () => !running && withAction(() => execute(slice.run.rows.flatMap((r, i) => (r.status === 'ok' ? [] : [i]))));

  /* ---------- reading a batch ---------- */
  /** Start over for this game and sort: no batches, no totals, and the next one starts at the first review. */
  function resetProgress(key) {
    Object.assign(slice, { key, cursor: '*', exhausted: false, batches: 0, tally: emptyTally(), run: null });
    emptyResults();
  }

  /** Read the next batch from Steam and put it on screen ready to run. Resolves false when there is nothing more to read. */
  async function readBatch(count = slice.count) {
    const game = parseSteamApp(slice.url);
    phase = 'fetching';
    syncButtons();
    say('');
    const data = await postSteamReviews({ app: game.appId, count, sort: slice.sort, cursor: slice.cursor }, controller.signal);
    const problem = batchReplyProblem(data);
    if (problem) throw new Error(problem); // before anything is changed, so the next press starts from the same place
    if (data.summary) slice.summary = data.summary; // Steam sends its totals with the first page only; keep the ones we have otherwise
    slice.cursor = data.cursor;
    slice.exhausted = data.done;
    if (data.reviews.length === 0) {
      say(hasProgress() ? 'That is every review Steam has for this game.' : `Steam has no written reviews for app ${game.appId}. Check the link.`);
      return false;
    }

    // The batch on screen is finished with: keep its counts, let its rows go, and put the new one in its place.
    const previous = slice.run;
    if (previous) slice.tally = mergeTallies(slice.tally, tallyRows(previous.rows));
    slice.game = { appId: game.appId, name: game.name };
    slice.batches++;
    const questions = steamQuestions();
    slice.run = {
      kind: 'steam',
      game: slice.game,
      batch: slice.batches,
      thumbs: slice.tellThumbs, // fixed for the batch, so resuming it reads every review the same way
      questions,
      model: DEFAULT_MODEL,
      rows: data.reviews.map((review, index) => ({
        index,
        text: review.text,
        expected: expectedFor(review),
        meta: { votedUp: review.votedUp, hoursTotal: review.hoursTotal, hoursAtReview: review.hoursAtReview, hoursRecent: review.hoursRecent, votesUp: review.votesUp, refunded: review.refunded, freeCopy: review.freeCopy, earlyAccess: review.earlyAccess, steamDeck: review.steamDeck },
        status: 'pending',
      })),
      marks: {},
      open: null,
      fatal: null,
      specs: mergeSpecs(questions, previous?.specs ?? steamSpecs()),
      settings: {
        panels: { overview: false, ...previous?.settings?.panels }, // a card for every question: the summary above says it better, so this starts closed
        minCertainty: previous?.settings?.minCertainty ?? DEFAULT_MIN_CERTAINTY,
        autoCheck: previous?.settings?.autoCheck ?? false,
        onlyReview: false,
        sort: { key: 'index', dir: 'asc' },
        compositeOn: previous?.settings?.compositeOn ?? false, // the topic cards are the answer here; a score column is opt-in
      },
    };
    save.steam();
    show();
    return true;
  }

  /** How many reviews Jev has been asked about so far, across every batch, counting the ones that failed. */
  const readCount = () => {
    const t = totalTally();
    return t.answered + t.failed;
  };

  /**
   * Analyse the next batch (or finish the one on screen, if it was stopped part way). With `until`, carry on batch after
   * batch until that many reviews have been read in all, until stopped, until Steam has no more, or until something goes
   * wrong that would go wrong every time. The last batch is cut short so it stops at `until` and not past it.
   */
  async function analyse({ until = 0 } = {}) {
    if (running) return;
    const game = parseSteamApp(slice.url);
    if (!game) return say(`Paste a Steam store link first, such as ${EXAMPLE_LINK}`);

    const key = keyOf();
    if (slice.key !== key) {
      if (hasProgress() && !confirm('You changed the link or settings. This starts over, and the totals so far are cleared. Continue?')) return;
      resetProgress(key);
    }
    if (slice.exhausted && !unfinished()) return say('That is every review Steam has for this game.');

    // One batch asks here. A run to a chosen share has already shown its cost in the popup, and been asked for there.
    if (!until && !app.status.mock) {
      const pending = unfinished() ? slice.run.rows.filter((r) => r.status !== 'ok' && r.status !== 'error').length : slice.count;
      if (pending > CONFIRM_ABOVE && !confirm(`This will make ${number(pending)} API calls with your key, roughly ${tokensFor(pending)} tokens. Continue?`)) return;
    }

    say('');
    await withAction(async () => {
      let first = true;
      const wantMore = () => until > 0 && !slice.exhausted && readCount() < until;
      do {
        if (!unfinished()) {
          const count = until ? Math.max(1, Math.min(slice.count, until - readCount())) : slice.count;
          if (!(await readBatch(count))) break;
          if (first) revealPane($('verdict'));
        }
        first = false;
        await execute(slice.run.rows.flatMap((r, i) => (r.status === 'ok' || r.status === 'error' ? [] : [i])));
        if (controller.signal.aborted || slice.run.fatal) break;
        if (wantMore()) say(`Analysing: ${number(readCount())} of ${number(until)} reviews so far. Stop to pause, and Analyse more carries on from here.`);
      } while (wantMore());
      if (until && !controller.signal.aborted && !slice.run?.fatal) say(slice.exhausted ? 'Done: that was every review Steam has for this game.' : `Done: ${number(readCount())} reviews analysed.`);
    });
  }

  /** How long a request to Jev takes, from the reviews on screen; null until there are enough to say. */
  function averageLatencyMs() {
    const times = (slice.run?.rows ?? []).filter((r) => r.status === 'ok' && r.latencyMs > 0).map((r) => r.latencyMs);
    return times.length >= 5 ? times.reduce((a, b) => a + b, 0) / times.length : null;
  }

  /**
   * The popup for "Analyse more…". A slider picks how much of the game to have analysed in all, as a percentage of its
   * reviews, from just above what is done up to everything. Under it, what that means: how many more reviews and
   * requests, roughly how many tokens, and how long it should take. Nothing is spent until Start.
   */
  async function openMore() {
    if (running) return;
    if (!parseSteamApp(slice.url)) return say(`Paste a Steam store link first, such as ${EXAMPLE_LINK}`);
    if (!(slice.summary?.totalReviews > 0)) await lookup(); // the slider is a share of the game, so it needs to know how big the game is
    const total = slice.summary?.totalReviews ?? 0;
    if (!(total > 0)) return say("Steam has not said how many reviews this game has, so there is nothing to pick a share of. Check the link and try again.");

    const analysed = onThisGame() ? readCount() : 0; // a changed link starts over, so nothing counts as done
    const range = moreSlider(total, analysed);
    if (range.done) return say('Every review Steam has for this game has been analysed.');

    const decimals = range.step < 1 ? 1 : 0;
    const slider = h('input', { type: 'range', id: 'steam-more-slider', min: range.min, max: range.max, step: range.step, value: range.min, 'aria-label': 'Share of the game to have analysed', oninput: update });
    const share = h('strong', { class: 'steam-more-share' });
    const sums = h('ul', { class: 'steam-more-sums' });
    const warning = h('p', { class: 'notice', hidden: true });
    const startBtn = h('button', { type: 'button', id: 'steam-more-start', class: 'btn btn-primary' });
    let target = 0;

    function update() {
      const percent = Number(slider.value);
      target = Math.max(analysed + 1, reviewsFor(total, percent));
      const more = target - analysed;
      const perOne = perReview();
      const seconds = averageLatencyMs() ? (more * averageLatencyMs()) / 1000 / slice.concurrency : null;

      share.textContent = `${percent.toFixed(decimals)}% of the game`;
      sums.replaceChildren(
        h('li', {}, h('strong', {}, `${number(more)} more reviews`), ` (${number(target)} in all, of the ${number(total)} on Steam)`),
        h('li', {}, `${number(more)} requests to Jev, in about ${number(Math.ceil(more / slice.count))} ${Math.ceil(more / slice.count) === 1 ? 'batch' : 'batches'} of ${slice.count}`),
        h('li', {}, h('strong', {}, `Roughly ${roughTokens(more * perOne)} tokens`), ` at about ${number(Math.round(perOne))} a review${totalTally().answered >= MEASURED_AFTER ? ', measured from the reviews already read' : ', a first estimate that is replaced by the real figure after 20 reviews'}`),
        ...(seconds ? [h('li', {}, `Around ${roughDuration(seconds)}, at the speed so far`)] : []),
      );
      warning.hidden = app.status.mock || more * perOne < 1e8;
      warning.textContent = 'That is a lot of tokens. Check the amount is what you want before you start.';
      startBtn.textContent = `Analyse ${number(more)} reviews`;
    }

    const presets = [1, 5, 10, 25, 50, 100].filter((p) => p >= range.min && p <= range.max).map((p) => h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { slider.value = String(p); update(); } }, `${p}%`));

    startBtn.addEventListener('click', () => {
      dialog.close();
      analyse({ until: target });
    });

    const dialog = document.querySelector('#steam-more-dialog');
    document.querySelector('#steam-more-body').replaceChildren(
      h('p', {}, `${number(total)} reviews on Steam, ${number(analysed)} analysed so far (${pct(Math.min(1, analysed / total))}). How much of the game do you want analysed?`),
      h('div', { class: 'steam-more-pick' }, slider, share),
      ...(presets.length > 0 ? [h('div', { class: 'steam-more-presets' }, 'Jump to ', presets)] : []),
      sums,
      ...(app.status.mock ? [h('p', { class: 'muted small' }, 'Mock mode: nothing is spent, the answers are made up.')] : []),
      warning,
      h('p', { class: 'muted small' }, 'It runs batch after batch until it gets there. You can stop at any time, and Analyse more carries on from the same place.'),
      h('div', { class: 'steam-more-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => dialog.close() }, 'Cancel'), startBtn),
    );
    update();
    dialog.showModal();
  }

  /** Empty the page: the link, the batches and the totals. */
  function clear() {
    if (running) stop();
    clearTimeout(lookupTimer);
    lookupController?.abort();
    Object.assign(slice, { url: '', game: null, summary: null, key: null, cursor: '*', exhausted: false, batches: 0, tally: emptyTally(), run: null, savedId: null });
    urlBox.value = '';
    renderGame();
    renderCost();
    renderProgress();
    emptyResults();
    syncButtons();
    say('');
  }

  const hasWork = () => slice.url.trim() !== '' || hasProgress();

  /** New query: start over. Results on this page are not kept in History, so ask first when there are some. */
  function reset() {
    if (hasProgress() && !confirm('Start a new query? This clears the link and everything read so far. Steam results are not kept in History.')) return;
    clear();
    save.steam();
    urlBox.focus();
  }

  /** Replace the page with a link (from an example), clearing everything else. */
  function load({ url = '' }) {
    clear();
    slice.url = url;
    urlBox.value = url;
    renderGame();
    save.steam();
    scheduleLookup();
  }

  /** Put a saved analysis back on the page, to carry on from where it stopped. */
  function restore(fields) {
    if (running) stop();
    clearTimeout(lookupTimer);
    lookupController?.abort();
    Object.assign(slice, fields);
    urlBox.value = slice.url;
    $('count').value = String(slice.count);
    $('sort').value = slice.sort;
    $('thumbs').checked = slice.tellThumbs;
    renderGame();
    renderCost();
    renderProgress();
    if (slice.run) show();
    else emptyResults();
    syncButtons();
    say('');
    save.steam();
  }

  document.querySelector('#runbar-steam').replaceChildren(runBtn, moreBtn, saveBtn, stopBtn, dockProgress, statusEl);

  // This batch and the table below it are cards that fold; keep each as you left it.
  const remember = (card, field) => {
    card.open = slice[field];
    card.addEventListener('toggle', () => {
      slice[field] = card.open;
      persistSoon();
    });
  };
  remember($('batch-card'), 'batchOpen');
  remember($('table-card'), 'tableOpen');

  renderGame();
  renderCost();
  renderProgress();
  if (slice.run) show();
  else emptyResults();
  syncButtons();
  if (!slice.summary) scheduleLookup(); // a link left from last time: ask Steam how many reviews it has

  return { start: () => analyse(), reset, load, hasWork, restore };
}
