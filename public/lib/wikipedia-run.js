import {
  articleParts, articleUrl, buildAnswerRequest, buildArticleRequest, buildCheckRequest, buildPartRequest, buildRefineRequest, buildTermRequest, mergeResults, meaningOptions, partCandidates,
  MAX_CHOICES, readAnswerChunks, readChoice, readMeaning, readYesNo, searchTerms,
} from './wikipedia.js';

// How far the search goes before it gives up. Each Jev request costs tokens; the best case is five. Every limit can be
// changed (see DEFAULT_SETTINGS), and `Infinity` means no limit.
export const LIMITS = {
  requests: 12, // requests to Jev, in total
  terms: 3, // search terms tried in all: the first path, then a different path for each after it
  articles: 3, // articles read, best first, over every path
  parts: 3, // parts of one article read, best first
  candidates: 3, // sentences or rows of one part checked, best first: when the check turns one down, the next is checked
};
// Starting points, tuned on the examples.
export const THRESHOLDS = {
  found: 0.6, // the Yes / No check must be at least this sure that the text answers the question
  snippet: 0.8, // a search snippet is shown at once as a quick answer when Jev is at least this sure it states the answer
  sureTerm: 0.6, // under this, the search term Jev ranked second is searched as well
  tryAt: 0.05, // after the first, an article, part or search term is only tried if Jev gave it at least this much: below that, it is a guess that costs requests
};
export const SEARCH_LIMIT = 8; // results per search

/* ---------- the settings a person can change ---------- */

/** What the page starts with. A limit of `null` is "no limit"; the two percentages are whole numbers. */
export const DEFAULT_SETTINGS = { requests: LIMITS.requests, articles: LIMITS.articles, parts: LIMITS.parts, terms: LIMITS.terms, candidates: LIMITS.candidates, accept: 60, skipUnder: 5, quick: true, refine: true };
/** The lowest and highest a setting can be. */
export const SETTING_RANGES = { requests: [1, 500], articles: [1, 50], parts: [1, 50], terms: [1, 10], candidates: [1, 50], accept: [10, 100], skipUnder: [0, 50] };
const LIMIT_SETTINGS = ['requests', 'articles', 'parts', 'terms', 'candidates'];
const SWITCH_SETTINGS = ['quick', 'refine'];

/** Stored settings, checked: anything missing or out of range goes back to its default, and a limit can be `null` for none. */
export function cleanSettings(stored) {
  const out = { ...DEFAULT_SETTINGS };
  if (!stored || typeof stored !== 'object') return out;
  for (const key of Object.keys(SETTING_RANGES)) {
    const value = stored[key];
    const [low, high] = SETTING_RANGES[key];
    if (LIMIT_SETTINGS.includes(key) && value === null) out[key] = null;
    else if (Number.isInteger(value) && value >= low && value <= high) out[key] = value;
  }
  for (const key of SWITCH_SETTINGS) if (typeof stored[key] === 'boolean') out[key] = stored[key];
  return out;
}

/** The settings as the options `findAnswer` takes. */
export function runOptions(settings) {
  const s = cleanSettings(settings);
  return {
    limits: { requests: s.requests ?? Infinity, articles: s.articles ?? Infinity, parts: s.parts ?? Infinity, terms: s.terms ?? Infinity, candidates: s.candidates ?? Infinity },
    thresholds: { found: s.accept / 100, tryAt: s.skipUnder / 100 },
    quick: s.quick,
    refine: s.refine,
  };
}

/* ---------- the steps ---------- */

class Stopped extends Error {}
class GaveUp extends Error {}

const lower = (title) => String(title).toLowerCase();

/** The options after the chosen one: what else Jev thought of, for the trail to fold underneath. */
const runnersUp = (ranked, chosen, label, count = 5) =>
  ranked
    .filter((r) => r !== chosen && r.p > 0)
    .slice(0, count)
    .map((r) => ({ label: label(r.item), p: r.p }));

/**
 * The options to try, best first, at most `count`: the first always, then only those Jev gave `floor` or more. Also says whether
 * options were left out for being under the floor (`belowFloor`) or for the count (`overCount`), which is what a "Not found" explains.
 */
function worthTrying(ranked, count, floor) {
  const eligible = ranked.filter((r, i) => i === 0 || r.p >= floor);
  const tries = eligible.slice(0, Math.max(0, count));
  return { tries, belowFloor: eligible.length < ranked.length, overCount: tries.length < eligible.length };
}

/**
 * A Choice as the trail draws it (the same card as on the Single page): every option Jev was given, best first, with its
 * probability, and "none of these" when the question had it. `key` is the option's id as Jev saw it.
 */
const choiceOptions = (ranked, describe, none) => {
  const rows = ranked.map((r) => ({ ...describe(r), p: r.p }));
  if (none !== undefined) rows.push({ key: 'none', label: 'None of these', p: none });
  return rows;
};
const confidenceOf = (answer) => (Number.isFinite(answer?.confidence) ? answer.confidence : null);

/**
 * Find a quote on Wikipedia that answers `question`, step by step, and say how sure Jev was at each one.
 *
 * Jev never writes the answer: at every step code builds a list of candidates and Jev picks one, so the answer is text
 * that is really on the page. The steps are (1) which search term, (2) which article, (3) which part of it, (4) which
 * sentence, and (5) a Yes / No on that sentence, which must be for exactly what the question specifies. When it fails, the steps go
 * back without asking Jev again where they can: the next best sentence or row of the same part, then the next part, then the next article.
 * (6) When the answer is a row (of a table, or of the infobox), it is cut into its pieces and Jev picks the one piece that is the answer. When the articles of a search are used up, a different
 * path is tried: the next search term, with its own results. It stops when the answer is found, or a limit is reached.
 *
 * Everything outside is passed in, so this can be run without a browser or a network:
 *  - `search(query, limit)` resolves with `{ results: [{ title, snippet }] }`;
 *  - `article(title)` resolves with `{ title, disambiguation, infobox, sections }` (an error with `status: 404` skips the article);
 *  - `run(request, signal)` sends a request to Jev and resolves with `{ answers, usage }`.
 * Options: `limits` and `thresholds` change `LIMITS` and `THRESHOLDS` (`Infinity` for no limit); `quick: false` leaves out
 * the quick answer from search snippets, and its questions; `refine: false` leaves out step 6; `avoid: { articles, terms }` skips articles and search terms
 * that an earlier run already used, which is how a different path is tried on purpose. `onProgress` is called with a
 * snapshot after every change, so a page can draw the trail as it grows. Aborting `signal` stops it as soon as the
 * request in flight comes back. It resolves with the last snapshot:
 *  - `status`: 'found', 'not-found' or 'stopped', and `reason` for a not-found;
 *  - `answer`: `{ text, refined, title, part, url, p, checked, before, after }`, or null (`refined` is the one piece of a row that is the answer, or ''); `best` is the closest one seen when there is none;
 *  - `quick`: a snippet Jev was sure answers the question, shown before the check, or null;
 *  - `trail`: one entry per step taken: `{ id, title, label, p, note, skipped, reused, others, none, meaning }`, and for a step
 *    Jev was asked, what it was asked (`instructions`, `state`) and what it thought (`chosen`, `options`, `confidence`);
 *  - `requests`, `tokens`, `ms`: what the run has cost so far; `searched` and `read`: the search terms used and articles opened.
 * A failure from `search`, `article` or `run` is thrown, with the snapshot so far on `err.progress`.
 */
export async function findAnswer(question, { search, article, run, signal, onProgress = () => {}, limits = {}, thresholds = {}, quick = true, refine = true, avoid = {} } = {}) {
  const max = { ...LIMITS };
  for (const key of Object.keys(limits)) if (limits[key] !== undefined) max[key] = limits[key] ?? Infinity;
  const at = { ...THRESHOLDS, ...thresholds };
  const started = performance.now();
  const state = { status: 'running', reason: '', requests: 0, tokens: 0, ms: 0, trail: [], quick: null, best: null, answer: null, searched: [], read: [] };
  const tried = new Set((avoid.articles ?? []).map(lower)); // articles already opened, on this run or an earlier one
  // Why it may have stopped short, for a "Not found": options left out for being under the floor, or for a limit.
  const left = { floor: false, limit: false };
  const snapshot = () => ({ ...state, ms: Math.round(performance.now() - started), trail: state.trail.map((entry) => ({ ...entry })), searched: [...state.searched], read: [...state.read] });
  const emit = () => onProgress(snapshot());
  const add = (entry) => {
    state.trail.push(entry);
    emit();
    return entry;
  };
  const guard = () => {
    if (signal?.aborted) throw new Stopped();
  };
  const ask = async (request) => {
    guard();
    if (state.requests >= max.requests) throw new GaveUp(`Gave up after ${max.requests} requests to Jev.`);
    state.requests += 1;
    emit();
    const reply = await run(request, signal);
    guard();
    state.tokens += (reply?.usage?.input_tokens ?? 0) + (reply?.usage?.output_tokens ?? 0);
    return reply?.answers ?? {};
  };

  /** Steps 3 to 5 on one article: the parts in order, each tried until an answer passes the check. */
  async function readArticle(data, entry) {
    const parts = articleParts(data);
    if (parts.length === 0) {
      entry.skipped = 'There is nothing on that page to read.';
      return emit();
    }

    const options = meaningOptions(question);
    const partRequest = buildPartRequest(question, data.title, parts);
    const answers = await ask(partRequest);
    const partRank = readChoice(answers.part, parts, 'p');
    const meaning = readMeaning(answers.meaning, options);

    const { tries, belowFloor, overCount } = worthTrying(partRank.ranked, max.parts, at.tryAt);
    if (belowFloor) left.floor = true;
    if (overCount) left.limit = true;
    for (const [n, pick] of tries.entries()) {
      const part = pick.item;
      const partEntry = add({
        id: 'part',
        title: 'Part',
        label: part.label,
        p: pick.p,
        note: n === 0 ? `of ${parts.length} parts` : 'next best part',
        reused: n > 0, // no request of its own: the answer to the first one is used again
        others: n === 0 ? runnersUp(partRank.ranked, pick, (p) => p.label) : [],
        none: n === 0 ? partRank.none : undefined,
        ...(n === 0
          ? {
              instructions: partRequest.questions.part.instructions,
              state: partRequest.state,
              chosen: `p${pick.index}`,
              options: choiceOptions(partRank.ranked, (r) => ({ key: `p${r.index}`, label: r.item.label }), partRank.none),
              confidence: confidenceOf(answers.part),
              meaning: {
                label: meaning[0].label,
                p: meaning[0].p,
                others: meaning.slice(1).filter((m) => m.p > 0),
                instructions: partRequest.questions.meaning.instructions,
                state: partRequest.state,
                chosen: meaning[0].label,
                options: meaning.map((m) => ({ key: m.label, label: options[m.label], p: m.p })),
                confidence: confidenceOf(answers.meaning),
              },
            }
          : {}),
      });

      const candidates = partCandidates(part);
      if (candidates.length === 0) {
        partEntry.skipped = 'There is nothing in that part to read.';
        emit();
        continue;
      }

      const { request, chunks } = buildAnswerRequest(question, data.title, part.label, candidates);
      const reply = await ask(request);
      const ranked = readAnswerChunks(reply, chunks);
      const top = ranked[0];
      const rejected = top.none >= top.p; // Jev thought "none of these" more likely than the best of them
      const number = (r) => `#${r.chunk * MAX_CHOICES + r.index + 1}`; // the sentence's place in the part
      add({
        id: 'answer',
        title: 'Answer',
        label: top.item.text,
        p: top.p,
        none: top.none,
        note: rejected ? 'Jev thought none of these states the answer' : undefined,
        others: runnersUp(ranked, top, (c) => c.text, 3),
        instructions: request.questions[`answer${top.chunk}`].instructions,
        state: request.state,
        chosen: number(top),
        options: choiceOptions(ranked, (r) => ({ key: number(r), label: r.item.text }), top.none),
        confidence: confidenceOf(reply[`answer${top.chunk}`]),
      });
      if (rejected) continue;

      // The best sentence or row is checked; if the check turns it down, the next best in the same part is, with no new request to Jev to choose.
      const { tries: contenders, belowFloor: fewerBelow, overCount: fewerOver } = worthTrying(ranked, max.candidates, at.tryAt);
      if (fewerBelow) left.floor = true;
      if (fewerOver) left.limit = true;
      for (const [k, contender] of contenders.entries()) {
        if (k > 0) add({ id: 'answer', title: 'Answer', label: contender.item.text, p: contender.p, note: 'next best answer', reused: true, others: [] });
        if (await judge(contender.item, contender.p, part, data)) return;
      }
    }
  }

  /** The final check on one sentence or row, and, if it passes and is a row, the refinement to its one piece. True when it is the answer. */
  async function judge(item, p, part, data) {
    const checkRequest = buildCheckRequest(question, data.title, part.label, item);
    const checked = readYesNo((await ask(checkRequest)).answers);
    add({
      id: 'check',
      title: 'Checked',
      label: checked >= at.found ? 'answers the question' : 'does not state the answer',
      p: checked,
      instructions: checkRequest.questions.answers.instructions,
      state: { question, article: data.title, part: part.label, sentence: item.text },
    });

    const found = {
      text: item.text,
      refined: '',
      title: data.title,
      part: part.label,
      url: articleUrl(data.title, part.anchor),
      p,
      checked,
      before: item.before,
      after: item.after,
    };
    if (!state.best || checked > state.best.checked) state.best = found;
    if (checked < at.found) return false;

    // A row passed: cut it into pieces and pick the one that is the answer. It is skipped, not failed, if that would use the last request.
    if (refine && item.pieces?.length > 1 && state.requests < max.requests) {
      const { request, pieces } = buildRefineRequest(question, data.title, part.label, item);
      const reply = await ask(request);
      const { ranked, none } = readChoice(reply.refine, pieces, 'r');
      const best = ranked[0];
      const kept = best.p > none; // "no single piece" being likelier than the best piece keeps the whole row
      add({
        id: 'refine',
        title: 'Refine',
        label: best.item,
        p: best.p,
        none,
        note: kept ? undefined : 'no single piece stood out, so the whole row is kept',
        others: runnersUp(ranked, best, (piece) => piece, 3),
        instructions: request.questions.refine.instructions,
        state: request.state,
        chosen: `r${best.index}`,
        options: choiceOptions(ranked, (r) => ({ key: `r${r.index}`, label: r.item }), none),
        confidence: confidenceOf(reply.refine),
      });
      if (kept) found.refined = best.item;
    }
    state.answer = found;
    return true;
  }

  try {
    let terms = searchTerms(question);
    if (terms.length === 0) throw new GaveUp('There is no question to look up.');
    // Search terms an earlier run used are left out, unless that is all there is.
    const avoidTerms = new Set((avoid.terms ?? []).map(lower));
    const fresh = terms.filter((t) => !avoidTerms.has(lower(t)));
    if (fresh.length > 0) terms = fresh;

    // 1. Which search term
    let termRank;
    let termEntry;
    if (terms.length === 1) {
      termRank = [{ item: terms[0], index: 0, p: 1 }];
      termEntry = add({ id: 'term', title: 'Search term', label: terms[0], p: 1, note: 'the only term, so Jev was not asked', others: [] });
    } else {
      const request = buildTermRequest(question, terms);
      const answers = await ask(request);
      termRank = readChoice(answers.term, terms, 't').ranked;
      termEntry = add({
        id: 'term',
        title: 'Search term',
        label: termRank[0].item,
        p: termRank[0].p,
        others: runnersUp(termRank, termRank[0], (t) => t),
        instructions: request.questions.term.instructions,
        state: request.state,
        chosen: `t${termRank[0].index}`,
        options: choiceOptions(termRank, (r) => ({ key: `t${r.index}`, label: r.item })),
        confidence: confidenceOf(answers.term),
      });
    }

    // 2. Search Wikipedia (free): the chosen term, and the runner-up too when Jev was not sure
    const usedTerms = [];
    const searched = async (entries) => {
      const lists = [];
      for (const t of entries) {
        guard();
        usedTerms.push(t);
        state.searched.push(t.item);
        lists.push((await search(t.item, SEARCH_LIMIT)).results ?? []);
        guard();
      }
      return mergeResults(lists).filter((r) => !tried.has(lower(r.title)));
    };
    /** The next search term to try, if the limits allow one. `ignoreFloor` is for when there is nothing left to read at all. */
    const nextTerm = (ignoreFloor) => {
      const unused = termRank.filter((t) => !usedTerms.includes(t));
      if (unused.length === 0) return null;
      if (usedTerms.length >= max.terms || state.read.length >= max.articles) {
        left.limit = true;
        return null;
      }
      const next = unused.find((t) => ignoreFloor || t.p >= at.tryAt) ?? null;
      if (!next) left.floor = true;
      return next;
    };

    /** Step 2 and after, on one search's results: which article, then each article in turn. */
    async function readResults(results) {
      const articleRequest = buildArticleRequest(question, results, { snippets: quick });
      const reply = await ask(articleRequest);
      const articleRank = readChoice(reply.article, results, 'a');
      if (quick) {
        const snippets = results.map((r, i) => ({ result: r, p: readYesNo(reply[`s${i}`]) }));
        const sure = snippets.filter((s) => s.p >= at.snippet).sort((a, b) => b.p - a.p)[0];
        if (sure && !state.quick) {
          state.quick = { text: sure.result.snippet, title: sure.result.title, url: articleUrl(sure.result.title), p: sure.p };
          emit();
        }
      }

      const { tries, belowFloor, overCount } = worthTrying(articleRank.ranked, max.articles - state.read.length, at.tryAt);
      if (belowFloor) left.floor = true;
      if (overCount) left.limit = true;
      for (const [n, pick] of tries.entries()) {
        guard();
        state.read.push(pick.item.title);
        tried.add(lower(pick.item.title));
        const entry = add({
          id: 'article',
          title: 'Article',
          label: pick.item.title,
          p: pick.p,
          note: n === 0 ? `of ${results.length} results` : 'next best article',
          reused: n > 0,
          others: n === 0 ? runnersUp(articleRank.ranked, pick, (r) => r.title) : [],
          none: n === 0 ? articleRank.none : undefined,
          ...(n === 0
            ? {
                instructions: articleRequest.questions.article.instructions,
                state: articleRequest.state,
                chosen: `a${pick.index}`,
                options: choiceOptions(articleRank.ranked, (r) => ({ key: `a${r.index}`, label: r.item.title }), articleRank.none),
                confidence: confidenceOf(reply.article),
              }
            : {}),
        });

        let data;
        try {
          data = await article(pick.item.title);
        } catch (err) {
          if (signal?.aborted || err?.name === 'AbortError') throw new Stopped();
          if (err?.status !== 404) throw err;
          entry.skipped = 'That article could not be found.';
          emit();
          continue;
        }
        guard();
        tried.add(lower(data.title));
        if (data.disambiguation) {
          entry.skipped = 'A disambiguation page: it only lists other articles.';
          emit();
          continue;
        }

        await readArticle(data, entry);
        if (state.answer) return;
      }
    }

    const first = [termRank[0], ...(termRank[0].p < at.sureTerm && termRank[1] ? [termRank[1]] : [])].slice(0, Math.max(1, max.terms));
    let results = await searched(first);
    if (first.length > 1 && results.length) termEntry.note = `Jev was not sure, so "${first[1].item}" was searched too`;

    for (;;) {
      if (results.length === 0) {
        // Nothing (new) to read: search with the next term, whatever Jev thought of it.
        const next = nextTerm(true);
        if (!next) break;
        add({ id: 'term', title: 'Search term', label: next.item, p: next.p, note: 'nothing new was found, so the next search term was tried', reused: true, others: [] });
        results = await searched([next]);
        continue;
      }
      await readResults(results);
      if (state.answer) break;
      // A different path: the next search term, if Jev gave it a chance.
      const next = nextTerm(false);
      if (!next) break;
      add({ id: 'term', title: 'Search term', label: next.item, p: next.p, note: 'a different path: no answer yet, so the next search term was tried', reused: true, others: [] });
      results = await searched([next]);
    }

    if (!state.answer) {
      if (state.read.length === 0) throw new GaveUp('Wikipedia found no articles for the search terms.');
      // Say why it stopped, and which setting would let it go on: "no limit" lifts the limits, but not the floor.
      let why = 'Jev did not find text that answers the question in the places it looked.';
      if (left.floor) why += ` It skipped articles, parts and search terms that Jev rated under ${Math.round(at.tryAt * 100)}%: set "Skip anything Jev rates under" to 0 to have it try those too.`;
      if (left.limit) why += ' The limits on articles, parts or search terms stopped it looking further: raise them, or choose No limit.';
      throw new GaveUp(why);
    }
    state.status = 'found';
  } catch (err) {
    if (err instanceof Stopped || err?.name === 'AbortError' || signal?.aborted) state.status = 'stopped';
    else if (err instanceof GaveUp) Object.assign(state, { status: 'not-found', reason: err.message });
    else {
      err.progress = snapshot();
      throw err;
    }
  }
  emit();
  return snapshot();
}
