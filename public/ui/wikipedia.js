import { h } from '../dom.js';
import { app, save } from './state.js';
import { cleanSettings, DEFAULT_SETTINGS, findAnswer, runOptions, SETTING_RANGES } from '../lib/wikipedia-run.js';
import { addSavedAnswer, savedAnswer } from '../lib/wikipedia.js';
import { pct } from '../results.js';
import { postRun, postWikipediaArticle, postWikipediaSearch } from './api.js';
import { flash } from './save-set.js';
import { revealPane } from './reveal.js';
import { renderWikipediaSavedMenu } from './wikipedia-saved.js';
import { answerBlock, sourceLink, statsView, stepsView } from './wikipedia-view.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const LIMIT_FIELDS = [
  ['requests', 'Most requests to Jev', 'Every request costs tokens. Five is the least a search can take.'],
  ['articles', 'Most articles to read', 'Best first, over every search term.'],
  ['parts', 'Most parts of an article to try', 'Best first. The infobox and each heading count as a part.'],
  ['terms', 'Most search terms to try', 'When the articles from one search term are used up, the next term is a different path.'],
];

/** The settings in a line, for the header of the Settings card: "12 requests · 3 articles · 3 parts · 3 search terms". */
const describeSettings = (s) =>
  [
    s.requests == null ? 'no request limit' : plural(s.requests, 'request'),
    s.articles == null ? 'any number of articles' : plural(s.articles, 'article'),
    s.parts == null ? 'any number of parts' : plural(s.parts, 'part'),
    s.terms == null ? 'any number of search terms' : plural(s.terms, 'search term'),
  ].join(' · ');

/**
 * The Wikipedia answer page: ask a plain question and get back a quote from Wikipedia that answers it, a link to the part
 * it came from, and the trail of steps Jev took, with how sure it was at each. The steps themselves are in
 * lib/wikipedia-run.js; this draws them as they happen, and keeps the answers you save (which are pages of their own, in
 * wikipedia-saved.js).
 *
 * Everything shown from Wikipedia is text, drawn as text: the server passes on no HTML, and nothing here builds any.
 * Links are made only from an article title, so they always lead to en.wikipedia.org.
 */
export function initWikipedia() {
  const slice = app.wikipedia;
  const $ = (id) => document.querySelector(`#wikipedia-${id}`);

  let running = false;
  let controller = null;
  let runId = 0; // a run that has been replaced (New query, an example) must not draw over the one that replaced it
  let progress = null; // the latest snapshot from findAnswer
  let failure = ''; // the message when a call failed
  const openSteps = new Set(); // which steps of the trail are unfolded (by their place in it), kept while the trail is drawn again as it grows
  // What earlier tries at this question used, so "Try a different path" can keep away from all of it, not only the last try.
  let avoid = { articles: new Set(), terms: new Set() };

  const say = (text) => {
    statusEl.textContent = text;
    statusEl.hidden = !text;
  };

  /* ---------- the question ---------- */
  const input = h('input', {
    type: 'text',
    id: 'wikipedia-question',
    class: 'text',
    'aria-label': 'Your question',
    placeholder: 'How big is Paris?',
    autocomplete: 'off',
    maxLength: 300,
    value: slice.question,
    oninput: (e) => {
      slice.question = e.target.value;
      save.wikipedia();
      syncButtons();
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        start();
      }
    },
  });

  /* ---------- settings ---------- */
  const sync = []; // one function for each setting, that puts it back on screen from what is stored
  const changed = () => {
    save.wikipedia();
    summaryEl.textContent = describeSettings(slice.settings);
    costEl.textContent = costHint();
  };

  /** A whole number with a "No limit" box beside it. */
  function limitField(key, label, hint) {
    const [low, high] = SETTING_RANGES[key];
    let last = slice.settings[key] ?? DEFAULT_SETTINGS[key]; // what the number goes back to when "No limit" is turned off
    const number = h('input', {
      type: 'number',
      class: 'text wiki-number',
      id: `wikipedia-set-${key}`,
      min: String(low),
      max: String(high),
      step: '1',
      'aria-label': label,
      onchange: (e) => {
        const n = Math.round(Number(e.target.value));
        if (Number.isFinite(n) && e.target.value !== '') last = Math.min(high, Math.max(low, n));
        slice.settings[key] = last;
        e.target.value = String(last);
        changed();
      },
    });
    const none = h('input', {
      type: 'checkbox',
      id: `wikipedia-set-${key}-none`,
      onchange: (e) => {
        slice.settings[key] = e.target.checked ? null : last;
        number.disabled = e.target.checked;
        changed();
      },
    });
    sync.push(() => {
      if (slice.settings[key] != null) last = slice.settings[key];
      number.value = String(slice.settings[key] ?? last);
      none.checked = slice.settings[key] == null;
      number.disabled = none.checked;
    });
    return h('div', { class: 'wiki-field' }, h('label', { for: number.id, class: 'wiki-field-label' }, label), h('div', { class: 'wiki-field-row' }, number, h('label', { class: 'check small' }, none, ' No limit')), h('p', { class: 'hint' }, hint));
  }

  /** A whole percentage. */
  function percentField(key, label, hint) {
    const [low, high] = SETTING_RANGES[key];
    const number = h('input', {
      type: 'number',
      class: 'text wiki-number',
      id: `wikipedia-set-${key}`,
      min: String(low),
      max: String(high),
      step: '1',
      'aria-label': label,
      onchange: (e) => {
        const n = Math.round(Number(e.target.value));
        slice.settings[key] = Number.isFinite(n) && e.target.value !== '' ? Math.min(high, Math.max(low, n)) : DEFAULT_SETTINGS[key];
        e.target.value = String(slice.settings[key]);
        changed();
      },
    });
    sync.push(() => (number.value = String(slice.settings[key])));
    return h('div', { class: 'wiki-field' }, h('label', { for: number.id, class: 'wiki-field-label' }, label), h('div', { class: 'wiki-field-row' }, number, h('span', { class: 'small muted' }, '%')), h('p', { class: 'hint' }, hint));
  }

  const quickBox = h('input', {
    type: 'checkbox',
    id: 'wikipedia-set-quick',
    onchange: (e) => {
      slice.settings.quick = e.target.checked;
      changed();
    },
  });
  sync.push(() => (quickBox.checked = slice.settings.quick));

  const summaryEl = h('span', { class: 'panel-headline' });
  const costEl = h('p', { class: 'hint' });
  const costHint = () => {
    const s = slice.settings;
    const noLimit = [s.requests, s.articles, s.parts, s.terms].some((limit) => limit == null);
    const lines = [s.requests == null ? 'With no limit on requests it keeps looking until every article, part and search term it is allowed has been tried, which can take many requests on a question with no answer.' : `A question that is answered takes about five requests (roughly 5,000 tokens). One that is not can use all ${s.requests}.`];
    // "No limit" lifts the limits, not the floor: this is the surprise worth saying out loud.
    if (noLimit && s.skipUnder > 0) lines.push(`Even with no limit, anything Jev rates under ${s.skipUnder}% is skipped, so it can still stop early. Set "Skip anything Jev rates under" to 0 to have it try everything.`);
    if (noLimit && s.skipUnder === 0) lines.push('Skipping nothing and with a limit removed, a question with no answer can use hundreds of requests.');
    return lines.join(' ');
  };

  const resetBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost btn-sm',
      onclick: () => {
        slice.settings = cleanSettings();
        for (const fn of sync) fn();
        changed();
      },
    },
    'Reset to defaults',
  );

  const settingsCard = h(
    'details',
    { class: 'panel panel-fold', id: 'wikipedia-settings-card' },
    h('summary', { class: 'panel-head' }, h('h2', {}, 'Settings'), summaryEl),
    h('p', { class: 'hint' }, 'How hard it looks before it gives up, and how sure it has to be. These apply to the next search.'),
    h(
      'div',
      { class: 'wiki-settings' },
      ...LIMIT_FIELDS.map(([key, label, hint]) => limitField(key, label, hint)),
      percentField('accept', 'Accept an answer when the final check is at least', 'The final Yes / No check has to be this sure that the sentence states the answer. Lower finds something more often, and is wrong more often.'),
      percentField('skipUnder', 'Skip anything Jev rates under', 'After the first choice, an article, part or search term is only tried if Jev gave it at least this much. 0 tries everything.'),
      h('div', { class: 'wiki-field' }, h('label', { class: 'check' }, quickBox, ' Show a quick answer from the search snippet'), h('p', { class: 'hint' }, 'When a search snippet already states the answer it is shown at once, while the article is checked. Off saves the Yes / No question on every snippet.')),
    ),
    costEl,
    h('div', {}, resetBtn),
  );

  document.querySelector('#mode-wikipedia').replaceChildren(
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Question')),
      input,
      h('p', { class: 'hint' }, 'Ask a plain question. Jev looks for a sentence on Wikipedia that answers it, and never writes the answer itself: it only picks from text that is really on the page. English Wikipedia only.'),
    ),
    settingsCard,
  );
  for (const fn of sync) fn();
  changed();

  /* ---------- the bottom bar ---------- */
  const runBtn = h('button', { type: 'button', id: 'wikipedia-run', class: 'btn btn-primary', onclick: () => start() }, 'Find answer');
  const saveBtn = h('button', { type: 'button', id: 'wikipedia-save', class: 'btn', title: 'Keep this answer, with the steps Jev took, under Wikipedia answer in the menu', onclick: () => saveAnswer() }, 'Save answer');
  const againBtn = h('button', { type: 'button', id: 'wikipedia-again', class: 'btn', hidden: true, title: 'Ask again from the start, with the settings as they are now', onclick: () => start() }, 'Try again');
  const pathBtn = h('button', { type: 'button', id: 'wikipedia-path', class: 'btn', hidden: true, title: 'Ask again, but keep away from the articles and search terms already used', onclick: () => start({ differentPath: true }) }, 'Try a different path');
  const stopBtn = h('button', { type: 'button', id: 'wikipedia-stop', class: 'btn', hidden: true, onclick: () => controller?.abort() }, 'Stop');
  const statusEl = h('span', { id: 'wikipedia-status', class: 'runbar-status', role: 'status', hidden: true });
  document.querySelector('#runbar-wikipedia').replaceChildren(runBtn, saveBtn, againBtn, pathBtn, stopBtn, statusEl);

  const isSaved = (answer) => slice.saved.some((s) => s.question === slice.question.trim() && s.url === answer.url && s.text === answer.text);
  const finished = () => !running && (progress != null || failure !== '');

  function syncButtons() {
    const blank = slice.question.trim() === '';
    runBtn.disabled = running || blank;
    const found = !running && progress?.status === 'found';
    saveBtn.disabled = !found || isSaved(progress.answer);
    saveBtn.textContent = found && isSaved(progress.answer) ? 'Saved' : 'Save answer';
    againBtn.hidden = pathBtn.hidden = !finished();
    againBtn.disabled = pathBtn.disabled = blank;
    stopBtn.hidden = !running;
  }

  const summary = (p) => {
    const asked = plural(p.requests, 'request');
    const limit = slice.settings.requests;
    if (p.status === 'running') return `Asking Jev: request ${p.requests}${limit == null ? '' : ` of ${limit}`}`;
    if (p.status === 'found') return `Found, with ${asked} to Jev.`;
    if (p.status === 'stopped') return `Stopped after ${asked} to Jev.`;
    return `Not found, after ${asked} to Jev.`;
  };

  /** Ask the question. `differentPath` keeps away from every article and search term used by the tries so far at this question. */
  async function start({ differentPath = false } = {}) {
    if (running) return;
    const question = slice.question.trim();
    if (!question) {
      say('Type a question first.');
      input.focus();
      return;
    }
    if (differentPath) {
      for (const title of progress?.read ?? []) avoid.articles.add(title);
      for (const term of progress?.searched ?? []) avoid.terms.add(term);
    } else avoid = { articles: new Set(), terms: new Set() };

    const mine = ++runId;
    running = true;
    failure = '';
    progress = null;
    openSteps.clear();
    controller = new AbortController();
    const { signal } = controller;
    say(differentPath ? 'Trying a different path…' : 'Starting…');
    syncButtons();
    render();
    revealPane($('answer'));

    try {
      progress = await findAnswer(question, {
        search: (query, limit) => postWikipediaSearch({ query, limit }, signal),
        article: (title) => postWikipediaArticle({ title }, signal),
        run: postRun,
        signal,
        ...runOptions(slice.settings),
        avoid: { articles: [...avoid.articles], terms: [...avoid.terms] },
        onProgress: (snapshot) => {
          if (mine !== runId) return;
          progress = snapshot;
          say(summary(snapshot));
          render();
        },
      });
    } catch (err) {
      if (mine !== runId) return;
      if (err.progress) progress = err.progress;
      failure = err.message || 'Something went wrong.';
    }
    if (mine !== runId) return;
    running = false;
    controller = null;
    syncButtons();
    render();
    say(failure ? '' : progress ? summary(progress) : '');
    if (progress?.status === 'found') revealPane($('answer')); // the answer, at the top of the results, is the first thing to see
  }

  /* ---------- saving ---------- */
  function saveAnswer() {
    if (progress?.status !== 'found' || isSaved(progress.answer)) return;
    const stats = { requests: progress.requests, tokens: progress.tokens, ms: progress.ms, articles: progress.read.length, terms: progress.searched };
    const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    slice.saved = addSavedAnswer(slice.saved, savedAnswer({ question: slice.question.trim(), answer: progress.answer, trail: progress.trail, stats, ts: Date.now(), id }));
    if (!save.wikipediaSaved()) flash('The browser has no room left to save this answer.');
    else flash('Answer saved. It is under Wikipedia answer in the menu.');
    renderWikipediaSavedMenu();
    syncButtons();
  }

  /* ---------- drawing ---------- */
  function quickCard(p) {
    const q = p.quick;
    const checking = p.status === 'running';
    return h(
      'div',
      { class: 'wiki-answer is-quick' },
      h('p', { class: 'wiki-tag' }, 'Quick answer from the search snippet'),
      h('blockquote', { class: 'wiki-quote' }, q.text),
      h(
        'p',
        { class: 'wiki-source small' },
        'From ',
        h('a', { href: q.url, target: '_blank', rel: 'noopener noreferrer' }, q.title),
        ` · Jev is ${pct(q.p)} sure this snippet states the answer. ${checking ? 'Checking it against the whole article…' : 'It was not confirmed by the whole article, and a snippet can be cut short.'}`,
      ),
    );
  }

  function notFoundCard(p) {
    return h(
      'div',
      { class: 'wiki-notfound' },
      h('p', {}, h('strong', {}, 'Not found. '), p.reason),
      p.best
        ? [
            h('p', { class: 'small muted' }, `The closest text Jev saw, which it is only ${pct(p.best.checked)} sure answers the question (it needs ${pct(slice.settings.accept / 100)}):`),
            h('blockquote', { class: 'wiki-quote' }, p.best.text),
            h('p', { class: 'wiki-source small' }, 'From ', sourceLink(p.best)),
          ]
        : null,
      h('p', { class: 'hint' }, 'The steps below show which one went wrong. Try again, try a different path, or change the settings and ask again.'),
    );
  }

  function renderAnswer() {
    const p = progress;
    const parts = [];
    if (failure) parts.push(h('div', { class: 'error', role: 'alert' }, failure));
    if (p?.status === 'found') parts.push(answerBlock(p.answer));
    else if (p) {
      if (p.quick) parts.push(quickCard(p));
      if (p.status === 'running') parts.push(h('p', { class: 'muted small' }, 'Looking…'));
      if (p.status === 'not-found') parts.push(notFoundCard(p));
      if (p.status === 'stopped') parts.push(h('p', { class: 'notice' }, 'Stopped. The steps below show how far it got.'));
    }
    if (parts.length === 0) parts.push(h('p', { class: 'muted' }, 'Ask a question and the answer appears here, with the page it came from.'));
    $('answer').replaceChildren(...parts);
  }

  function renderTrail() {
    if (!progress) {
      $('trail').replaceChildren(h('p', { class: 'muted' }, running ? 'Starting…' : 'Every step Jev takes is shown here, with how sure it was: which search term, which article, which part of it, which sentence, and a last check. The numbers for the run are above the steps.'));
      return;
    }
    const stats = { requests: progress.requests, tokens: progress.tokens, ms: progress.ms, articles: progress.read.length, terms: progress.searched };
    const pending = running ? (progress.requests ? `Asking Jev (request ${progress.requests}${slice.settings.requests == null ? '' : ` of ${slice.settings.requests}`})…` : 'Starting…') : '';
    $('trail').replaceChildren(statsView(stats, { checked: progress.answer?.checked ?? null, requestLimit: slice.settings.requests }), stepsView(progress.trail, { chosenText: progress.answer?.text ?? '', pending, open: openSteps, onToggle: (index, open) => (open ? openSteps.add(index) : openSteps.delete(index)) }));
  }

  function render() {
    renderAnswer();
    renderTrail();
  }

  /* ---------- New query and examples ---------- */
  /** Forget the answer on screen and stop anything running. The question box, the settings and the saved answers are not touched. */
  function clearResult() {
    controller?.abort();
    runId += 1;
    running = false;
    controller = null;
    progress = null;
    failure = '';
    openSteps.clear();
    avoid = { articles: new Set(), terms: new Set() };
    say('');
    syncButtons();
    render();
  }

  const hasWork = () => slice.question.trim() !== '' || progress != null;

  /** New query: start over. Only an answer that was found and not saved is worth asking about, because it cost tokens. */
  function reset() {
    if (progress?.status === 'found' && !isSaved(progress.answer) && !confirm('Start a new query? The answer on screen has not been saved.')) return;
    clearResult();
    slice.question = '';
    input.value = '';
    save.wikipedia();
    syncButtons();
    input.focus();
  }

  /** Put a question in the box (an example, or a saved answer's "Ask again"), clearing the answer. */
  function load({ question = '' }) {
    clearResult();
    slice.question = question;
    input.value = question;
    save.wikipedia();
    syncButtons();
    input.focus();
  }

  syncButtons();
  render();
  return { start: () => start(), reset, load, hasWork };
}
