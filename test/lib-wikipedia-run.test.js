import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRequest } from '../src/validate.js';
import { cleanTrail, mergeTables, parseInfobox, parseTables, searchTerms, splitSections, splitSentences } from '../public/lib/wikipedia.js';
import { cleanSettings, DEFAULT_SETTINGS, findAnswer as findAnswerWith, LIMITS, runOptions, SETTING_RANGES } from '../public/lib/wikipedia-run.js';

// Most of these tests are about the steps before the last one, which cuts a row into its pieces, so that is off unless a test turns it on.
// Classification (step 0) is its own test section below, with its own fakeJev rules, so it is off here by default too.
const findAnswer = (question, options = {}) => findAnswerWith(question, { refine: false, classify: false, ...options });

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/wikipedia/${name}`, import.meta.url), 'utf8'));

/** Paris as the server would hand it over: from the saved replies, through the same code. */
const paris = () => ({
  title: 'Paris',
  disambiguation: false,
  infobox: parseInfobox(fixture('parse-paris.json').parse.text),
  sections: splitSections(fixture('extract-paris.json').query.pages[0].extract).map((s) => ({ path: s.path, anchor: s.anchor, sentences: splitSentences(s.text) })),
});
const page = (title, sentences = ['A sentence about it.', 'Another sentence.']) => ({ title, disambiguation: false, infobox: [], sections: [{ path: 'Lead', anchor: '', sentences }] });

/** The probabilities of a Choice: `given` maps a key to its probability, and what is left is shared out between the other keys. */
function choiceAnswer(criteria, given) {
  const keys = Object.keys(criteria);
  const taken = Object.values(given).reduce((a, b) => a + b, 0);
  const others = keys.filter((k) => !(k in given));
  const probabilities = Object.fromEntries(keys.map((k) => [k, k in given ? given[k] : others.length ? Math.max(0, 1 - taken) / others.length : 0]));
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
}
/** The key of the option whose description matches. */
const keyFor = (criteria, test) => Object.keys(criteria).find((k) => (test instanceof RegExp ? test.test(criteria[k]) : criteria[k] === test));

/**
 * A pretend Jev. `rules` says what it thinks at each step, and the requests it was sent are recorded (and checked to be
 * valid, as the real server would). By default it is sure about the right thing for "How big is Paris?".
 */
function fakeJev(overrides = {}) {
  const requests = [];
  const rules = {
    term: (q) => ({ [keyFor(q.criteria, 'Paris')]: 0.91 }),
    article: (q) => ({ [keyFor(q.criteria, /^Paris: /)]: 0.94 }),
    part: (q) => ({ [keyFor(q.criteria, /^Infobox/)]: 0.81 }),
    meaning: (q) => ({ area: 0.62, population: 0.31 }),
    answer: (q) => ({ [keyFor(q.criteria, /^Area: /)]: 0.88 }),
    check: () => 0.93,
    refine: (q) => ({ r0: 0.9 }),
    snippet: () => 0.2,
    ...overrides,
  };
  const run = async (request) => {
    assert.equal(validateRequest(request).ok, true, JSON.stringify(validateRequest(request).errors));
    requests.push(request);
    const answers = {};
    for (const [id, q] of Object.entries(request.questions)) {
      if (id === 'answers') answers[id] = { type: 'noul', noul: rules.check(request) };
      else if (/^s\d+$/.test(id)) answers[id] = { type: 'noul', noul: rules.snippet(id, request) };
      else if (/^answer\d+$/.test(id)) answers[id] = choiceAnswer(q.criteria, rules.answer(q, request));
      else answers[id] = choiceAnswer(q.criteria, rules[id](q, request));
    }
    return { answers, usage: { input_tokens: 100, output_tokens: 10 } };
  };
  return { run, requests, ids: () => requests.map((r) => Object.keys(r.questions)[0]) };
}

const RESULTS = [
  { title: 'How Big, How Blue, How Beautiful', snippet: 'An album by Florence and the Machine.' },
  { title: 'Paris Is Burning (film)', snippet: 'A 1990 documentary film.' },
  { title: 'Paris', snippet: 'Paris is the capital and largest city of France, with an area of 105.4 km2 (40.7 sq mi).' },
];

/** A fake Wikipedia: the search gives `results` for any term, and each title has a page. */
function fakeWorld({ results = RESULTS, pages = { Paris: paris() } } = {}) {
  const searches = [];
  const opened = [];
  return {
    searches,
    opened,
    search: async (query, limit) => (searches.push({ query, limit }), { results: typeof results === 'function' ? results(query) : results }),
    article: async (title) => {
      opened.push(title);
      if (!pages[title]) throw Object.assign(new Error('There is no such article.'), { status: 404 });
      return pages[title];
    },
  };
}

const QUESTION = 'How big is Paris?';

test('the best case takes five requests to Jev: term, article, part, answer, check', async () => {
  const jev = fakeJev();
  const world = fakeWorld();
  const result = await findAnswer(QUESTION, { ...world, run: jev.run });

  assert.equal(result.status, 'found');
  assert.equal(result.requests, 5);
  assert.deepEqual(jev.ids(), ['term', 'article', 'part', 'answer0', 'answers']);
  assert.deepEqual(result.trail.map((s) => s.id), ['term', 'article', 'part', 'answer', 'check']);
  assert.deepEqual(world.searches, [{ query: 'Paris', limit: 8 }], 'Jev was sure of the term, so one search');
  assert.deepEqual(world.opened, ['Paris']);

  assert.match(result.answer.text, /^Area: 105\.4 km2 \(40\.7 sq mi\) • Urban 2,824\.2 km2/);
  assert.equal(result.answer.url, 'https://en.wikipedia.org/wiki/Paris');
  assert.equal(result.answer.part, 'Infobox');
  assert.equal(result.answer.title, 'Paris');
  assert.equal(result.answer.checked, 0.93);
});

test('the trail says what Jev chose at each step and how sure it was, with the runners-up and what the question means', async () => {
  const jev = fakeJev();
  const { trail } = await findAnswer(QUESTION, { ...fakeWorld(), run: jev.run });
  const [term, article, part, answer, check] = trail;

  assert.deepEqual([term.title, term.label, term.p], ['Search term', 'Paris', 0.91]);
  assert.ok(term.others.some((o) => o.label === QUESTION), 'the runner-up is kept underneath');
  assert.deepEqual([article.label, article.p, article.note], ['Paris', 0.94, 'of 3 results']);
  assert.deepEqual([part.label, part.p], ['Infobox', 0.81]);
  assert.equal(part.meaning.label, 'area');
  assert.equal(part.meaning.p, 0.62);
  assert.equal(part.meaning.others[0].label, 'population', 'the meanings that came second and after are folded underneath');
  assert.match(answer.label, /^Area: /);
  assert.equal(answer.p, 0.88);
  assert.deepEqual([check.title, check.label, check.p], ['Checked', 'answers the question', 0.93]);
});

test('the question asked at each step is the one Jev is meant to see', async () => {
  const jev = fakeJev();
  await findAnswer(QUESTION, { ...fakeWorld(), run: jev.run });
  const [term, article, part, answer, check] = jev.requests;
  assert.deepEqual(term.state, { question: QUESTION });
  assert.equal(Object.keys(article.questions).filter((id) => /^s\d+$/.test(id)).length, 3, 'a Yes / No for each snippet, in the same request');
  assert.deepEqual(part.state, { question: QUESTION, article: 'Paris' });
  assert.ok('meaning' in part.questions, 'what the question means is asked in the same request as the part');
  assert.deepEqual(answer.state, { question: QUESTION, article: 'Paris', part: 'Infobox' });
  assert.equal(check.state.part, 'Infobox');
  assert.match(check.state.sentence, /^Area: /);
});

test('the runner-up search term is searched too when Jev is under 60% sure, and the results are merged without repeats', async () => {
  const jev = fakeJev({ term: (q) => ({ [keyFor(q.criteria, 'Paris')]: 0.5, [keyFor(q.criteria, QUESTION)]: 0.4 }) });
  const world = fakeWorld({ results: (query) => (query === 'Paris' ? RESULTS.slice(2) : RESULTS) });
  const result = await findAnswer(QUESTION, { ...world, run: jev.run });
  assert.deepEqual(world.searches.map((s) => s.query), ['Paris', QUESTION]);
  assert.match(result.trail[0].note, /searched too/);
  const articles = jev.requests[1].questions.article.criteria;
  assert.equal(Object.keys(articles).length, 3 + 1, 'three articles once, and "none"');
  assert.equal(result.status, 'found');
});

test('a search that finds nothing falls back to the next term, and a search that finds nothing at all gives up after one request', async () => {
  const jev = fakeJev();
  const world = fakeWorld({ results: (query) => (query === QUESTION ? RESULTS : []) });
  const result = await findAnswer(QUESTION, { ...world, run: jev.run });
  assert.deepEqual(world.searches.map((s) => s.query), ['Paris', QUESTION]);
  const terms = result.trail.filter((s) => s.id === 'term');
  assert.deepEqual(terms.map((t) => t.label), ['Paris', QUESTION]);
  assert.match(terms[1].note, /nothing new was found/);
  assert.equal(result.status, 'found');

  const empty = fakeJev();
  const none = await findAnswer(QUESTION, { ...fakeWorld({ results: [] }), run: empty.run });
  assert.equal(none.status, 'not-found');
  assert.match(none.reason, /no articles/);
  assert.equal(none.requests, 1, 'only the term was asked about');
});

test('with only one search term Jev is not asked to choose it, so it is one request fewer', async () => {
  const jev = fakeJev({ article: (q) => ({ [keyFor(q.criteria, /^Paris: /)]: 0.9 }) });
  const result = await findAnswer('what is it?', { ...fakeWorld(), run: jev.run });
  assert.equal(result.trail[0].p, 1);
  assert.match(result.trail[0].note, /Jev was not asked/);
  assert.deepEqual(jev.ids()[0], 'article');
});

test('a failed check goes on to the next part by probability, with no new request for the part', async () => {
  const jev = fakeJev({
    part: (q) => ({ [keyFor(q.criteria, /^Infobox/)]: 0.6, [keyFor(q.criteria, 'Lead: the opening paragraphs, which summarise the article')]: 0.3 }),
    answer: (q) => (Object.values(q.criteria).some((c) => /^Area: /.test(c)) ? { [keyFor(q.criteria, /^Area: /)]: 0.85 } : { [keyFor(q.criteria, /an area of 105\.4 km2/)]: 0.9 }),
    check: (request) => (/^Area: /.test(request.state.sentence) ? 0.2 : 0.95),
  });
  const result = await findAnswer(QUESTION, { ...fakeWorld(), run: jev.run });

  assert.equal(result.status, 'found');
  assert.equal(result.requests, 7, 'term, article, part, then answer and check for each of two parts');
  assert.deepEqual(jev.ids(), ['term', 'article', 'part', 'answer0', 'answers', 'answer0', 'answers']);
  assert.equal(result.answer.part, 'Lead');
  assert.match(result.answer.text, /an area of 105\.4 km2/);
  assert.equal(result.answer.url, 'https://en.wikipedia.org/wiki/Paris', 'the lead has no heading to link to');
  const parts = result.trail.filter((s) => s.id === 'part');
  assert.deepEqual(parts.map((p) => [p.label, p.note === 'next best part']), [['Infobox', false], ['Lead', true]]);
  assert.equal(result.trail.filter((s) => s.id === 'check').length, 2);
  assert.equal(result.best.checked, 0.95);
});

test('a part with an answer is linked to its own heading', async () => {
  const jev = fakeJev({
    part: (q) => ({ [keyFor(q.criteria, 'Geography › Climate')]: 0.8 }),
    answer: (q) => ({ [Object.keys(q.criteria)[0]]: 0.8 }),
  });
  const result = await findAnswer(QUESTION, { ...fakeWorld(), run: jev.run });
  assert.equal(result.answer.url, 'https://en.wikipedia.org/wiki/Paris#Climate');
  assert.equal(result.answer.part, 'Geography › Climate');
});

test('when Jev says none of the sentences state it, the check is skipped for that part', async () => {
  const jev = fakeJev({
    part: (q) => ({ [keyFor(q.criteria, /^Infobox/)]: 0.6, [keyFor(q.criteria, 'Etymology')]: 0.3 }),
    answer: (q, request) => (request.state.part === 'Infobox' ? { none: 0.9 } : { [Object.keys(q.criteria)[0]]: 0.7 }),
  });
  const result = await findAnswer(QUESTION, { ...fakeWorld(), run: jev.run });
  assert.deepEqual(jev.ids(), ['term', 'article', 'part', 'answer0', 'answer0', 'answers'], 'no check for the part that had no answer');
  const rejected = result.trail.find((s) => s.id === 'answer');
  assert.match(rejected.note, /none of these states the answer/);
  assert.equal(result.answer.part, 'Etymology');
});

test('a failed article goes on to the next article by probability, reusing the answer to the article question', async () => {
  const jev = fakeJev({
    article: (q) => ({ [keyFor(q.criteria, /^Paris Is Burning/)]: 0.6, [keyFor(q.criteria, /^Paris: /)]: 0.3 }),
    part: (q, request) => (request.state.article === 'Paris' ? { [keyFor(q.criteria, /^Infobox/)]: 0.8 } : { [keyFor(q.criteria, 'Lead: the opening paragraphs, which summarise the article')]: 0.9 }),
    answer: (q, request) => (request.state.article === 'Paris' ? { [keyFor(q.criteria, /^Area: /)]: 0.9 } : { none: 0.95 }),
  });
  const world = fakeWorld({ pages: { Paris: paris(), 'Paris Is Burning (film)': page('Paris Is Burning (film)') } });
  const result = await findAnswer(QUESTION, { ...world, run: jev.run });

  assert.equal(result.status, 'found');
  assert.deepEqual(world.opened, ['Paris Is Burning (film)', 'Paris']);
  assert.equal(jev.requests.filter((r) => 'article' in r.questions).length, 1, 'the article question is asked once');
  const articles = result.trail.filter((s) => s.id === 'article');
  assert.deepEqual(articles.map((a) => [a.label, a.note]), [['Paris Is Burning (film)', 'of 3 results'], ['Paris', 'next best article']]);
  assert.equal(result.answer.title, 'Paris');
});

test('a disambiguation page is skipped without asking Jev anything about it', async () => {
  const mercury = { title: 'Mercury', disambiguation: true, infobox: [], sections: [{ path: 'Lead', anchor: '', sentences: ['Mercury most commonly refers to:'] }] };
  const results = [{ title: 'Mercury', snippet: 'Mercury most commonly refers to' }, { title: 'Mercury (planet)', snippet: 'The closest planet to the Sun.' }];
  const jev = fakeJev({
    term: (q) => ({ [keyFor(q.criteria, 'Mercury')]: 0.9 }),
    article: (q) => ({ [keyFor(q.criteria, /^Mercury: /)]: 0.5, [keyFor(q.criteria, /^Mercury \(planet\)/)]: 0.4 }),
    part: (q) => ({ [keyFor(q.criteria, /^Lead/)]: 0.9 }),
    answer: (q) => ({ [Object.keys(q.criteria)[0]]: 0.8 }),
  });
  const world = fakeWorld({ results, pages: { Mercury: mercury, 'Mercury (planet)': page('Mercury (planet)', ['Its age is about 4.5 billion years.']) } });
  const result = await findAnswer('How old is Mercury?', { ...world, run: jev.run });

  assert.equal(result.status, 'found');
  assert.equal(result.requests, 5, 'the disambiguation page cost no request');
  assert.deepEqual(world.opened, ['Mercury', 'Mercury (planet)']);
  const skipped = result.trail.find((s) => s.id === 'article' && s.label === 'Mercury');
  assert.match(skipped.skipped, /disambiguation/);
  assert.equal(result.answer.title, 'Mercury (planet)');
});

test('an article that cannot be found (a 404) is skipped, and any other failure is thrown with the trail so far', async () => {
  const jev = fakeJev({ article: (q) => ({ [keyFor(q.criteria, /^Paris Is Burning/)]: 0.6, [keyFor(q.criteria, /^Paris: /)]: 0.3 }) });
  const world = fakeWorld(); // no page for the film
  const result = await findAnswer(QUESTION, { ...world, run: jev.run });
  assert.equal(result.status, 'found');
  assert.match(result.trail.find((s) => s.label === 'Paris Is Burning (film)').skipped, /could not be found/);

  const broken = fakeWorld();
  broken.article = async () => {
    throw Object.assign(new Error('Wikipedia is limiting requests (429).'), { status: 429 });
  };
  await assert.rejects(findAnswer(QUESTION, { ...broken, run: fakeJev().run }), (err) => {
    assert.match(err.message, /limiting requests/);
    assert.deepEqual(err.progress.trail.map((s) => s.id), ['term', 'article']);
    assert.equal(err.progress.requests, 2);
    return true;
  });

  const jevDown = async () => {
    throw new Error('TypeSafe rejected the API key (401).');
  };
  await assert.rejects(findAnswer(QUESTION, { ...fakeWorld(), run: jevDown }), (err) => err.progress.requests === 1 && err.progress.trail.length === 0);
});

test('it gives up at 12 requests to Jev, showing "Not found" with the closest thing it saw', async () => {
  // Every part has a sentence Jev likes, but the check never passes, so it keeps looking until the requests run out.
  const jev = fakeJev({
    article: (q) => ({ [keyFor(q.criteria, /^Paris Is Burning/)]: 0.5, [keyFor(q.criteria, /^Paris: /)]: 0.4 }),
    part: (q) => ({ [keyFor(q.criteria, /^Lead/)]: 0.5, [keyFor(q.criteria, /^Infobox/)]: 0.3 }),
    answer: (q) => ({ [Object.keys(q.criteria)[0]]: 0.8 }),
    check: () => 0.3,
  });
  // The film's page has three parts, so it takes 1 + 3 x 2 = 7 requests, and Paris runs out of requests partway.
  const film = { ...page('Paris Is Burning (film)'), sections: ['Lead', 'Plot', 'Release'].map((path) => ({ path, anchor: path, sentences: ['One.', 'Two.'] })) };
  const world = fakeWorld({ pages: { Paris: paris(), 'Paris Is Burning (film)': film } });
  const result = await findAnswer(QUESTION, { ...world, run: jev.run });

  assert.equal(result.status, 'not-found');
  assert.equal(result.requests, 12);
  assert.equal(jev.requests.length, 12, 'the 13th request was never sent');
  assert.match(result.reason, /Gave up after 12 requests/);
  assert.equal(result.answer, null);
  assert.equal(result.best.checked, 0.3, 'the closest thing seen is kept');
  assert.equal(LIMITS.requests, 12);
});

test('it can run out of places to look without reaching the limit', async () => {
  const jev = fakeJev({ answer: () => ({ none: 0.9 }), part: (q) => ({ [keyFor(q.criteria, /^Lead/)]: 0.9 }) });
  const world = fakeWorld({ results: RESULTS.slice(2) });
  const result = await findAnswer(QUESTION, { ...world, run: jev.run });
  assert.equal(result.status, 'not-found');
  assert.match(result.reason, /did not find text/);
  assert.ok(result.requests < 12);
  assert.equal(result.best, null);
});

test('at most three articles and three parts are tried', async () => {
  const pages = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`Page ${i}`, { ...page(`Page ${i}`), sections: Array.from({ length: 6 }, (_, s) => ({ path: `S${s}`, anchor: `S${s}`, sentences: ['One.', 'Two.'] })) }]));
  const results = Object.keys(pages).map((title) => ({ title, snippet: 'x' }));
  const jev = fakeJev({ article: (q) => ({ a0: 0.2, a1: 0.18, a2: 0.16, a3: 0.14, a4: 0.12, a5: 0.1 }), part: (q) => Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, 0.15])), answer: () => ({ none: 0.9 }), term: () => ({ t0: 0.9 }) });
  const world = fakeWorld({ results, pages });
  const result = await findAnswer(QUESTION, { ...world, run: jev.run, limits: { requests: 100 } });
  assert.equal(world.opened.length, 3);
  assert.equal(result.trail.filter((s) => s.id === 'part').length, 9, 'three parts of each of three articles');
});

test('a snippet Jev is 80% sure states the answer is shown at once as a quick answer, before the check comes back', async () => {
  const jev = fakeJev({ snippet: (id) => (id === 's2' ? 0.85 : 0.1) });
  const snapshots = [];
  const result = await findAnswer(QUESTION, { ...fakeWorld(), run: jev.run, onProgress: (s) => snapshots.push(s) });
  assert.equal(result.quick.title, 'Paris');
  assert.equal(result.quick.p, 0.85);
  assert.match(result.quick.text, /an area of 105\.4 km2/);
  assert.equal(result.quick.url, 'https://en.wikipedia.org/wiki/Paris');
  const firstQuick = snapshots.findIndex((s) => s.quick);
  const firstAnswer = snapshots.findIndex((s) => s.answer);
  assert.ok(firstQuick >= 0 && firstQuick < firstAnswer, 'the quick answer is on screen while the full path is still going');
  assert.equal(snapshots[firstQuick].status, 'running');

  const unsure = await findAnswer(QUESTION, { ...fakeWorld(), run: fakeJev({ snippet: () => 0.79 }).run });
  assert.equal(unsure.quick, null);
});

test('onProgress gets a snapshot after every change, and a snapshot is not changed by what happens next', async () => {
  const snapshots = [];
  const result = await findAnswer(QUESTION, { ...fakeWorld(), run: fakeJev().run, onProgress: (s) => snapshots.push(s) });
  assert.ok(snapshots.length >= 8);
  assert.deepEqual(snapshots.map((s) => s.requests), [...snapshots.map((s) => s.requests)].sort((a, b) => a - b), 'requests only go up');
  assert.deepEqual(snapshots.map((s) => s.trail.length), [...snapshots.map((s) => s.trail.length)].sort((a, b) => a - b));
  assert.equal(snapshots[0].status, 'running');
  assert.equal(snapshots.at(-1).status, 'found');
  assert.deepEqual(snapshots.at(-1), result);
  assert.ok(snapshots[2].trail.length < result.trail.length);
});

test('Stop: aborting partway ends the run at once with what there is, and asks Jev nothing more', async () => {
  const controller = new AbortController();
  const jev = fakeJev();
  const run = async (request, signal) => {
    const reply = await jev.run(request, signal);
    if (jev.requests.length === 2) controller.abort(); // stopped while the answer to the article question is on its way back
    return reply;
  };
  const world = fakeWorld();
  const result = await findAnswer(QUESTION, { ...world, run, signal: controller.signal });
  assert.equal(result.status, 'stopped');
  assert.equal(result.requests, 2);
  assert.equal(result.answer, null);
  assert.deepEqual(result.trail.map((s) => s.id), ['term'], 'the reply that came back after Stop is not used');
  assert.deepEqual(world.opened, [], 'nothing more was read from Wikipedia');
});

test('Stop: an abort error from the request, or a signal that is already aborted, is a stop and not a failure', async () => {
  const controller = new AbortController();
  const run = async () => {
    controller.abort();
    throw new DOMException('The operation was aborted.', 'AbortError');
  };
  const stopped = await findAnswer(QUESTION, { ...fakeWorld(), run, signal: controller.signal });
  assert.equal(stopped.status, 'stopped');

  const before = new AbortController();
  before.abort();
  const jev = fakeJev();
  const never = await findAnswer(QUESTION, { ...fakeWorld(), run: jev.run, signal: before.signal });
  assert.equal(never.status, 'stopped');
  assert.equal(jev.requests.length, 0);
  assert.equal(never.requests, 0);
});

test('there is nothing to look up for an empty question', async () => {
  const jev = fakeJev();
  const result = await findAnswer('   ', { ...fakeWorld(), run: jev.run });
  assert.equal(result.status, 'not-found');
  assert.equal(jev.requests.length, 0);
});

test('after the first, an article or part is only tried if Jev gave it at least 5%: below that it is a guess that costs requests', async () => {
  const oneSection = (title) => ({ ...page(title), sections: ['Lead', 'Plot'].map((path) => ({ path, anchor: path, sentences: ['One.', 'Two.'] })) });
  const results = [{ title: 'First', snippet: 'a' }, { title: 'Second', snippet: 'b' }, { title: 'Third', snippet: 'c' }];
  const pages = { First: oneSection('First'), Second: oneSection('Second'), Third: oneSection('Third') };
  const jev = (second, plot) =>
    fakeJev({
      term: () => ({ t0: 0.9 }),
      article: () => ({ a0: 0.9, a1: second, a2: 0.01 }), // the third is always a long shot
      part: () => ({ p0: 0.9, p1: plot }),
      answer: () => ({ none: 0.9 }),
    });

  const low = fakeWorld({ results, pages });
  await findAnswer(QUESTION, { ...low, run: jev(0.04, 0.04).run, limits: { terms: 1 } }); // one search term, so a different path is not tried here
  assert.deepEqual(low.opened, ['First'], 'the second article at 4% is not read');

  const enough = fakeWorld({ results, pages });
  const kept = jev(0.05, 0.05);
  const result = await findAnswer(QUESTION, { ...enough, run: kept.run, limits: { terms: 1 } });
  assert.deepEqual(enough.opened, ['First', 'Second'], 'at 5% it is, and the one at 1% is not');
  assert.deepEqual(result.trail.filter((s) => s.id === 'part').map((s) => s.label), ['Lead', 'Plot', 'Lead', 'Plot'], 'and so is the second part');
});

/* ---------- settings, limits and different paths ---------- */

test('the settings start at the defaults, are checked when stored, and become the options findAnswer takes', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { requests: 12, articles: 3, parts: 3, terms: 3, candidates: 3, accept: 60, skipUnder: 5, quick: true, refine: true, classify: true });
  assert.deepEqual(cleanSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(cleanSettings('junk'), DEFAULT_SETTINGS);
  assert.deepEqual(
    cleanSettings({ requests: null, articles: 7, parts: 0, terms: 'x', candidates: null, accept: 5, skipUnder: 99, quick: false, refine: 'no' }),
    { ...DEFAULT_SETTINGS, requests: null, articles: 7, candidates: null, quick: false },
    'null is "no limit"; what is out of range or not a number goes back to its default',
  );
  assert.equal(cleanSettings({ accept: null }).accept, 60, 'only a limit can be null');
  assert.equal(cleanSettings({ requests: 2.5 }).requests, 12);
  for (const [key, [low, high]] of Object.entries(SETTING_RANGES)) {
    assert.equal(cleanSettings({ [key]: low })[key], low, key);
    assert.equal(cleanSettings({ [key]: high })[key], high, key);
    assert.equal(cleanSettings({ [key]: high + 1 })[key], DEFAULT_SETTINGS[key], key);
  }

  assert.deepEqual(runOptions(DEFAULT_SETTINGS), { limits: { requests: 12, articles: 3, parts: 3, terms: 3, candidates: 3 }, thresholds: { found: 0.6, tryAt: 0.05 }, quick: true, refine: true, classify: true });
  const none = runOptions({ requests: null, articles: null, parts: null, terms: null, candidates: null, accept: 80, skipUnder: 0, quick: false, refine: false });
  assert.deepEqual(none.limits, { requests: Infinity, articles: Infinity, parts: Infinity, terms: Infinity, candidates: Infinity });
  assert.deepEqual([none.thresholds, none.quick, none.refine], [{ found: 0.8, tryAt: 0 }, false, false]);
});

/** A world where every part has a sentence Jev likes but the check never passes, so it keeps looking until something stops it. */
function hopeless() {
  const jev = fakeJev({
    article: (q) => ({ [keyFor(q.criteria, /^Paris Is Burning/)]: 0.5, [keyFor(q.criteria, /^Paris: /)]: 0.4 }),
    part: (q) => ({ [keyFor(q.criteria, /^Lead/)]: 0.5, [keyFor(q.criteria, /^Infobox/)]: 0.3 }),
    answer: (q) => ({ [Object.keys(q.criteria)[0]]: 0.8 }),
    check: () => 0.3,
  });
  const film = { ...page('Paris Is Burning (film)'), sections: ['Lead', 'Plot', 'Release'].map((path) => ({ path, anchor: path, sentences: ['One.', 'Two.'] })) };
  return { jev, world: fakeWorld({ pages: { Paris: paris(), 'Paris Is Burning (film)': film } }) };
}

test('the request limit can be raised, or removed: it then stops only when there is nowhere left to look', async () => {
  const capped = hopeless();
  const twelve = await findAnswer(QUESTION, { ...capped.world, run: capped.jev.run });
  assert.equal(twelve.requests, 12);

  const raised = hopeless();
  const more = await findAnswer(QUESTION, { ...raised.world, run: raised.jev.run, limits: { requests: 40 } });
  assert.ok(more.requests > 12 && more.requests < 40, String(more.requests));
  assert.match(more.reason, /did not find text/, 'it ran out of places to look, not out of requests');

  const unlimited = hopeless();
  const all = await findAnswer(QUESTION, { ...unlimited.world, run: unlimited.jev.run, ...runOptions({ ...DEFAULT_SETTINGS, requests: null }), classify: false });
  assert.equal(all.requests, more.requests, 'no limit gets no further than a high one when the candidates run out');

  const one = hopeless();
  const tiny = await findAnswer(QUESTION, { ...one.world, run: one.jev.run, limits: { requests: 3 } });
  assert.equal(tiny.requests, 3);
  assert.match(tiny.reason, /Gave up after 3 requests/);
});

test('the article and part limits can be raised or removed, and the articles limit counts over every path', async () => {
  const pages = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`Page ${i}`, { ...page(`Page ${i}`), sections: Array.from({ length: 6 }, (_, p) => ({ path: `S${p}`, anchor: `S${p}`, sentences: ['One.', 'Two.'] })) }]),
  );
  const results = Object.keys(pages).map((title) => ({ title, snippet: 'x' }));
  const rules = {
    article: () => ({ a0: 0.2, a1: 0.18, a2: 0.16, a3: 0.14, a4: 0.12, a5: 0.1 }),
    part: () => Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, 0.15])),
    answer: () => ({ none: 0.9 }),
  };
  const opened = async (options) => {
    const world = fakeWorld({ results, pages });
    const result = await findAnswer(QUESTION, { ...world, run: fakeJev(rules).run, ...options, classify: false });
    return { opened: world.opened.length, parts: result.trail.filter((s) => s.id === 'part').length };
  };
  assert.equal((await opened({ limits: { requests: Infinity, articles: 5 } })).opened, 5);
  assert.equal((await opened({ limits: { requests: Infinity, articles: 5, parts: 2 } })).parts, 10, 'two parts of each of five articles');
  const everything = await opened(runOptions({ ...DEFAULT_SETTINGS, requests: null, articles: null, parts: null, skipUnder: 0 }));
  assert.equal(everything.opened, 6, 'no limit: every result is read');
  assert.equal(everything.parts, 36, 'and every part of each');
  assert.equal((await opened({ limits: { requests: Infinity, articles: 1 } })).opened, 1, 'one article is a limit too');
});

test('a different path: when the articles of a search are used up, the next search term is tried, with its own results', async () => {
  const jev = fakeJev({
    term: (q) => ({ [keyFor(q.criteria, 'Paris')]: 0.8, [keyFor(q.criteria, QUESTION)]: 0.15 }),
    article: (q) => (Object.values(q.criteria).some((c) => /^Paris Is Burning/.test(c)) ? { [keyFor(q.criteria, /^Paris Is Burning/)]: 0.9 } : { [keyFor(q.criteria, /^Paris: /)]: 0.9 }),
    part: (q, request) => (request.state.article === 'Paris' ? { [keyFor(q.criteria, /^Infobox/)]: 0.8 } : { [keyFor(q.criteria, /^Lead/)]: 0.9 }),
    answer: (q, request) => (request.state.article === 'Paris' ? { [keyFor(q.criteria, /^Area: /)]: 0.9 } : { none: 0.95 }),
  });
  const world = fakeWorld({ results: (query) => (query === 'Paris' ? [RESULTS[1]] : [RESULTS[2]]), pages: { Paris: paris(), 'Paris Is Burning (film)': page('Paris Is Burning (film)') } });
  const result = await findAnswer(QUESTION, { ...world, run: jev.run });

  assert.equal(result.status, 'found');
  assert.deepEqual(world.searches.map((s) => s.query), ['Paris', QUESTION], 'the second path searched the next term');
  const terms = result.trail.filter((s) => s.id === 'term');
  assert.deepEqual(terms.map((t) => t.label), ['Paris', QUESTION]);
  assert.match(terms[1].note, /different path/);
  assert.equal(terms[1].reused, true, 'no request of its own: the ranking of the terms is used again');
  assert.equal(jev.requests.filter((r) => 'article' in r.questions).length, 2, 'each path asks which article once');
  assert.deepEqual(result.searched, ['Paris', QUESTION]);
  assert.equal(result.answer.title, 'Paris');
});

test('a different path is not tried when the search terms limit is 1, or when Jev gave the next term almost no chance', async () => {
  const rules = {
    term: (q) => ({ [keyFor(q.criteria, 'Paris')]: 0.97 }),
    article: (q) => ({ [keyFor(q.criteria, /^Paris Is Burning/)]: 0.9 }),
    part: (q) => ({ [keyFor(q.criteria, /^Lead/)]: 0.9 }),
    answer: () => ({ none: 0.9 }),
  };
  const results = () => [RESULTS[1]];
  const pages = { 'Paris Is Burning (film)': page('Paris Is Burning (film)') };

  const unlikely = fakeWorld({ results, pages });
  await findAnswer(QUESTION, { ...unlikely, run: fakeJev(rules).run });
  assert.deepEqual(unlikely.searches.map((s) => s.query), ['Paris'], 'the other term got 3%, under the 5% floor');

  const allowed = fakeWorld({ results, pages });
  await findAnswer(QUESTION, { ...allowed, run: fakeJev(rules).run, thresholds: { tryAt: 0.02 } });
  assert.equal(allowed.searches.length, 2, 'with a lower floor it is tried');

  const one = fakeWorld({ results, pages });
  await findAnswer(QUESTION, { ...one, run: fakeJev(rules).run, thresholds: { tryAt: 0 }, limits: { terms: 1 } });
  assert.equal(one.searches.length, 1, 'one search term is the limit');
});

test('avoid: articles and search terms an earlier run used are left out, which is how a different path is tried on purpose', async () => {
  const jev = fakeJev({ term: (q) => ({ [keyFor(q.criteria, QUESTION)]: 0.9 }), article: (q) => ({ [keyFor(q.criteria, /^Paris: /)]: 0.9 }) });
  const world = fakeWorld();
  const result = await findAnswer(QUESTION, { ...world, run: jev.run, avoid: { articles: ['Paris Is Burning (film)', 'how big, how blue, how beautiful'], terms: ['Paris'] } });
  assert.equal('term' in jev.requests[0].questions, false, 'Paris was used before, so one term is left, and Jev is not asked to choose between one');
  assert.deepEqual(world.searches.map((s) => s.query), [QUESTION]);
  const offered = Object.values(jev.requests[0].questions.article.criteria);
  assert.equal(offered.some((c) => /Paris Is Burning|How Big/.test(c)), false, 'the articles read before are not offered again');
  assert.equal(result.status, 'found');

  // If everything was used before, it starts again from all of them rather than having nothing to search for.
  const again = fakeWorld();
  const all = await findAnswer(QUESTION, { ...again, run: fakeJev().run, avoid: { terms: ['How big is Paris?', 'Paris'] } });
  assert.equal(all.status, 'found');
  assert.ok(again.searches.length >= 1);
});

test('a run reports what it cost: requests, tokens and time, the terms searched and the articles opened', async () => {
  const result = await findAnswer(QUESTION, { ...fakeWorld(), run: fakeJev().run });
  assert.equal(result.requests, 5);
  assert.equal(result.tokens, 5 * 110);
  assert.ok(Number.isInteger(result.ms) && result.ms >= 0);
  assert.deepEqual(result.searched, ['Paris']);
  assert.deepEqual(result.read, ['Paris']);
});

test('quick answers can be switched off: the snippets are not asked about, so it costs less', async () => {
  const on = fakeJev({ snippet: () => 0.95 });
  const withQuick = await findAnswer(QUESTION, { ...fakeWorld(), run: on.run });
  assert.ok(withQuick.quick);
  assert.ok('s0' in on.requests[1].questions);

  const off = fakeJev({ snippet: () => 0.95 });
  const without = await findAnswer(QUESTION, { ...fakeWorld(), run: off.run, quick: false });
  assert.equal(without.quick, null);
  assert.equal(Object.keys(off.requests[1].questions).some((id) => /^s\d+$/.test(id)), false);
  assert.equal(without.status, 'found');
});

test('a step Jev was asked carries what the trail needs to draw the same card as the Single page: the question, the options and how sure', async () => {
  const jev = fakeJev({ term: (q) => ({ [keyFor(q.criteria, 'Paris')]: 0.91, [keyFor(q.criteria, QUESTION)]: 0.09 }) });
  const { trail } = await findAnswer(QUESTION, { ...fakeWorld(), run: jev.run });
  const [term, article, part, answer, check] = trail;

  assert.match(term.instructions, /Which search term is most likely to find/);
  assert.deepEqual(term.state, { question: QUESTION });
  assert.equal(term.chosen, 't1');
  assert.deepEqual(term.options.map((o) => [o.key, o.label]), [['t1', 'Paris'], ['t0', QUESTION]]);
  assert.equal(term.options[0].p, 0.91);
  assert.equal(term.confidence, 0.91, "Jev's own confidence is kept");

  assert.equal(article.chosen, 'a2');
  assert.deepEqual(article.options.at(-1), { key: 'none', label: 'None of these', p: article.none });
  assert.ok(article.options.every((o) => Number.isFinite(o.p)));
  assert.equal(part.options[0].label, 'Infobox');
  assert.equal(part.meaning.chosen, 'area');
  assert.deepEqual(part.meaning.options.map((o) => o.key), ['area', 'population', 'both', 'other']);
  assert.equal(part.meaning.options[0].label, 'Its land area', 'the description of each meaning');
  assert.match(answer.options[0].key, /^#\d+$/, 'a sentence is numbered by its place in the part');
  assert.match(answer.options[0].label, /^Area: /);
  assert.equal(answer.options.at(-1).key, 'none');
  assert.match(check.instructions, /state the answer to/);
  assert.match(check.state.sentence, /^Area: /);
  assert.deepEqual(Object.keys(check.state).sort(), ['article', 'part', 'question', 'sentence']);
});

test('a "Not found" says why it stopped: options Jev rated under the floor, or a limit, and which setting to change', async () => {
  // "what is it?" has one search term, so only the articles and their parts can be left out.
  const oneSection = (title) => ({ ...page(title), sections: ['Lead', 'Plot'].map((path) => ({ path, anchor: path, sentences: ['One.', 'Two.'] })) });
  const results = [{ title: 'First', snippet: 'a' }, { title: 'Second', snippet: 'b' }, { title: 'Third', snippet: 'c' }];
  const pages = { First: oneSection('First'), Second: oneSection('Second'), Third: oneSection('Third') };
  const jev = () => fakeJev({ article: () => ({ a0: 0.9, a1: 0.04, a2: 0.03 }), part: () => ({ p0: 0.9, p1: 0.03 }), answer: () => ({ none: 0.9 }) });
  const ask = (options) => findAnswer('what is it?', { ...fakeWorld({ results, pages }), run: jev().run, ...options, classify: false });

  const floor = await ask({});
  assert.equal(floor.status, 'not-found');
  assert.match(floor.reason, /did not find text/);
  assert.match(floor.reason, /rated under 5%/);
  assert.match(floor.reason, /set "Skip anything Jev rates under" to 0/);
  assert.doesNotMatch(floor.reason, /limits on articles/, 'nothing was left out for a limit');

  // No limit lifts the limits, but not the floor: this is the case that looked like it should have gone on.
  const noLimit = await ask(runOptions({ ...DEFAULT_SETTINGS, requests: null, articles: null, parts: null, terms: null, candidates: null }));
  assert.match(noLimit.reason, /rated under 5%/);
  assert.ok(noLimit.requests < 12, 'it stopped well short of anything a limit would have stopped');

  // With the floor at 0 as well, it tries everything, and has nothing left to blame.
  const everything = await ask(runOptions({ ...DEFAULT_SETTINGS, requests: null, articles: null, parts: null, terms: null, skipUnder: 0 }));
  assert.equal(everything.reason, 'Jev did not find text that answers the question in the places it looked.');
  assert.ok(everything.requests > floor.requests, 'so it looked further');
  assert.equal(everything.trail.filter((s) => s.id === 'article').length, 3);

  // A limit that cut the list short is named too, and the floor is not blamed when nothing was under it.
  const rated = fakeJev({ article: () => ({ a0: 0.5, a1: 0.3, a2: 0.2 }), part: () => ({ p0: 0.6, p1: 0.4 }), answer: () => ({ none: 0.9 }) });
  const limited = await findAnswer('what is it?', { ...fakeWorld({ results, pages }), run: rated.run, limits: { articles: 1, parts: 1 } });
  assert.match(limited.reason, /limits on articles, parts or search terms stopped it/);
  assert.match(limited.reason, /choose No limit/);
  assert.doesNotMatch(limited.reason, /rated under/);
});

test('a search term Jev rated under the floor is named as skipped, and a term limit as a limit', async () => {
  const results = () => [RESULTS[1]];
  const pages = { 'Paris Is Burning (film)': page('Paris Is Burning (film)') };
  const rules = { term: (q) => ({ [keyFor(q.criteria, 'Paris')]: 0.97 }), article: (q) => ({ [keyFor(q.criteria, /^Paris Is Burning/)]: 0.9 }), part: (q) => ({ [keyFor(q.criteria, /^Lead/)]: 0.9 }), answer: () => ({ none: 0.9 }) };
  const floor = await findAnswer(QUESTION, { ...fakeWorld({ results, pages }), run: fakeJev(rules).run });
  assert.match(floor.reason, /rated under 5%/, 'the other search term got 3%');

  const limited = await findAnswer(QUESTION, { ...fakeWorld({ results, pages }), run: fakeJev(rules).run, thresholds: { tryAt: 0 }, limits: { terms: 1 } });
  assert.match(limited.reason, /limits on articles, parts or search terms/);
});

test('the trail keeps every option Jev was given, not only the top few: all the terms, articles, parts and sentences, and "none"', async () => {
  const sections = Array.from({ length: 20 }, (_, i) => ({ path: `Section ${i}`, anchor: `S${i}`, sentences: Array.from({ length: 30 }, (_, s) => `Sentence ${s} of section ${i}.`) }));
  const big = { ...page('Paris'), infobox: [{ label: 'Area', value: '1 km2' }], sections };
  const results = Array.from({ length: 9 }, (_, i) => ({ title: i === 0 ? 'Paris' : `Other ${i}`, snippet: 'x' }));
  const jev = fakeJev({
    term: (q) => ({ [keyFor(q.criteria, 'Paris')]: 0.9 }),
    article: (q) => ({ [keyFor(q.criteria, /^Paris: /)]: 0.9 }),
    part: (q) => ({ [keyFor(q.criteria, /^Section 4/)]: 0.8 }),
    answer: (q) => ({ [Object.keys(q.criteria)[3]]: 0.9 }),
  });
  const { trail } = await findAnswer(QUESTION, { ...fakeWorld({ results, pages: { Paris: big } }), run: jev.run });
  const step = (id) => trail.find((s) => s.id === id);

  assert.equal(step('term').options.length, searchTerms(QUESTION).length, 'every search term');
  assert.equal(step('article').options.length, 9 + 1, 'all nine results, and none');
  assert.equal(step('part').options.length, 21 + 1, 'the infobox and all twenty sections, and none');
  assert.equal(step('answer').options.length, 30 + 1, 'all thirty sentences of the part, and none');
  assert.equal(new Set(step('part').options.map((o) => o.key)).size, 22, 'each with its own key');
  assert.match(step('part').note, /of 21 parts/, 'the count in the note is the count of rows');

  // ... and a saved answer keeps them too, up to what a step can ever have.
  const saved = cleanTrail(JSON.parse(JSON.stringify(trail)));
  assert.equal(saved.find((s) => s.id === 'part').options.length, 22);
  const many = Array.from({ length: 400 }, (_, i) => ({ key: `c${i}`, label: `Sentence ${i}`, p: 0.001 }));
  assert.equal(cleanTrail([{ id: 'answer', options: many }])[0].options.length, 300);
});

/* ---------- the next best answer, the exact check, and refining a row ---------- */

const refined = (question, options = {}) => findAnswerWith(question, { classify: false, ...options });
const areaRows = (q) => keyFor(q.criteria, /^Area: /);

test('when the check turns the best row down, the next best row of the same part is checked, with no new request to choose', async () => {
  const jev = fakeJev({
    answer: (q) => ({ [areaRows(q)]: 0.5, [keyFor(q.criteria, /^Country: /)]: 0.3, [keyFor(q.criteria, /^Region: /)]: 0.1 }),
    check: (request) => (/^Area: /.test(request.state.sentence) ? 0.2 : 0.9),
  });
  const result = await findAnswer(QUESTION, { ...fakeWorld(), run: jev.run });
  assert.equal(result.status, 'found');
  assert.match(result.answer.text, /^Country: /, 'the second row passed');
  assert.deepEqual(jev.ids(), ['term', 'article', 'part', 'answer0', 'answers', 'answers'], 'one request for the choice, one check for each row');
  const steps = result.trail.map((s) => s.id + (s.reused ? '*' : ''));
  assert.deepEqual(steps, ['term', 'article', 'part', 'answer', 'check', 'answer*', 'check'], 'the second row is a step with no request of its own');
  assert.equal(result.trail.find((s) => s.reused && s.id === 'answer').note, 'next best answer');
  assert.equal(result.best.checked, 0.9);
});

test('how many rows of a part are checked is limited, and a row Jev gave under the floor is not checked', async () => {
  const rules = () => ({
    answer: (q) => ({ [areaRows(q)]: 0.5, [keyFor(q.criteria, /^Country: /)]: 0.2, [keyFor(q.criteria, /^Region: /)]: 0.04 }),
    check: () => 0.1,
    part: (q) => ({ [keyFor(q.criteria, /^Infobox/)]: 0.97 }),
  });
  const two = fakeJev(rules());
  const floor = await findAnswer(QUESTION, { ...fakeWorld(), run: two.run });
  assert.equal(two.requests.filter((r) => 'answers' in r.questions).length, 2, 'the row at 4% is under the 5% floor');
  assert.match(floor.reason, /rated under 5%/);

  const one = fakeJev(rules());
  const limited = await findAnswer(QUESTION, { ...fakeWorld(), run: one.run, limits: { candidates: 1 } });
  assert.equal(one.requests.filter((r) => 'answers' in r.questions).length, 1);
  assert.match(limited.reason, /limits on articles, parts or search terms/);

  const all = fakeJev(rules());
  await findAnswer(QUESTION, { ...fakeWorld(), run: all.run, ...runOptions({ ...DEFAULT_SETTINGS, refine: false, skipUnder: 0, candidates: null }), classify: false });
  assert.ok(all.requests.filter((r) => 'answers' in r.questions).length >= 3, 'with no floor and no limit every row is checked');
});

test('the final check asks for every detail of the question to match, not only for an answer of the right kind', async () => {
  const jev = fakeJev();
  await findAnswer(QUESTION, { ...fakeWorld(), run: jev.run });
  const check = jev.requests.find((r) => 'answers' in r.questions);
  assert.match(check.questions.answers.instructions, /exactly what the question specifies/);
  assert.match(check.questions.answers.instructions, /model, engine, year or place/);
});

test('a row that passes the check is cut into its pieces, and Jev picks the one that is the answer', async () => {
  const jev = fakeJev({ refine: (q) => ({ [keyFor(q.criteria, /^Area: /)]: 0.9, [keyFor(q.criteria, /^Urban /)]: 0.05, [keyFor(q.criteria, /^Metro /)]: 0.03 }) });
  const result = await refined(QUESTION, { ...fakeWorld(), run: jev.run });
  assert.equal(result.status, 'found');
  assert.equal(result.requests, 6, 'one more request, after the check');
  assert.deepEqual(jev.ids(), ['term', 'article', 'part', 'answer0', 'answers', 'refine']);
  assert.equal(result.answer.refined, 'Area: 105.4 km2 (40.7 sq mi)');
  assert.ok(result.answer.text.startsWith('Area: 105.4 km2 (40.7 sq mi) • Urban 2,824.2'), 'the whole row is kept too');
  const step = result.trail.at(-1);
  assert.deepEqual([step.id, step.title, step.label, step.chosen], ['refine', 'Refine', 'Area: 105.4 km2 (40.7 sq mi)', 'r0']);
  assert.deepEqual(step.options.map((o) => o.key), ['r0', 'r1', 'r2', 'none'], 'the pieces of the row, and none');
  assert.match(step.state.row, /^Area: 105.4 km2/);
  const request = jev.requests.at(-1);
  assert.deepEqual(request.state, { question: QUESTION, article: 'Paris', part: 'Infobox', row: result.answer.text });
  assert.match(request.questions.refine.instructions, /Which piece of the row/);
  assert.equal(request.questions.refine.criteria.none, 'No single piece states it');
});

test('refining keeps the whole row when Jev says no single piece is it, is left out when it is off, and is skipped when it would use the last request', async () => {
  const noPiece = await refined(QUESTION, { ...fakeWorld(), run: fakeJev({ refine: () => ({ none: 0.9 }) }).run });
  assert.equal(noPiece.status, 'found');
  assert.equal(noPiece.answer.refined, '');
  assert.match(noPiece.trail.at(-1).note, /whole row is kept/);

  const off = fakeJev();
  const result = await refined(QUESTION, { ...fakeWorld(), run: off.run, refine: false });
  assert.equal(result.requests, 5);
  assert.equal(off.ids().includes('refine'), false);

  const tight = await refined(QUESTION, { ...fakeWorld(), run: fakeJev().run, limits: { requests: 5 } });
  assert.equal(tight.status, 'found', 'an answer is not lost for the sake of the refinement');
  assert.equal(tight.requests, 5);
  assert.equal(tight.answer.refined, '');
});

test('a sentence of prose, or a row of one piece, is not refined: there is nothing to choose between', async () => {
  const jev = fakeJev({
    part: (q) => ({ [keyFor(q.criteria, /^Lead/)]: 0.9 }),
    answer: (q) => ({ [keyFor(q.criteria, /an area of 105.4 km2/)]: 0.9 }),
  });
  const prose = await refined(QUESTION, { ...fakeWorld(), run: jev.run });
  assert.equal(prose.requests, 5);
  assert.equal(prose.trail.some((s) => s.id === 'refine'), false);
  assert.equal(prose.answer.refined, '');

  const one = fakeJev({ answer: (q) => ({ [keyFor(q.criteria, /^Country: /)]: 0.9 }) });
  const single = await refined(QUESTION, { ...fakeWorld(), run: one.run });
  assert.match(single.answer.text, /^Country: France$/);
  assert.equal(single.requests, 5, 'a one-piece row has no pieces to choose between');
});

test('a row of a table is refined to its cell, and the cell is one of the row', async () => {
  const c4 = () => {
    const sections = mergeTables(splitSections(fixture('extract-c4-picasso.json').query.pages[0].extract).map((s) => ({ path: s.path, anchor: s.anchor, sentences: splitSentences(s.text) })), parseTables(fixture('parse-c4-picasso.json').parse.text));
    return { title: 'Citroën C4 Picasso', disambiguation: false, infobox: [], sections };
  };
  const question = 'what is the top speed of a Citroën C4 Picasso for the 1.6 litre VTi 16v model';
  const jev = fakeJev({
    term: (q) => ({ [keyFor(q.criteria, 'Citroën C4 Picasso')]: 0.9 }),
    article: (q) => ({ [keyFor(q.criteria, /^Citroën C4 Picasso: /)]: 0.9 }),
    part: (q) => ({ [keyFor(q.criteria, /^Engines/)]: 0.95 }),
    answer: (q) => ({ [keyFor(q.criteria, /Model: 1.6 litre VTi 16v/)]: 0.9 }),
    check: (request) => (/VTi/.test(request.state.sentence) ? 0.95 : 0.07),
    refine: (q) => ({ [keyFor(q.criteria, /^Top speed: /)]: 0.9 }),
  });
  const world = fakeWorld({ results: [{ title: 'Citroën C4 Picasso', snippet: 'A compact MPV.' }], pages: { 'Citroën C4 Picasso': c4() } });
  const result = await refined(question, { ...world, run: jev.run });
  assert.equal(result.status, 'found');
  assert.equal(result.answer.refined, 'Top speed: 187 km/h (116 mph)');
  assert.match(result.answer.text, /Model: 1.6 litre VTi 16v • Years: 2006–present/);
  assert.equal(result.answer.url, 'https://en.wikipedia.org/wiki/Citro%C3%ABn_C4_Picasso#Engines');
  const parts = jev.requests.find((r) => 'part' in r.questions).questions.part.criteria;
  assert.ok(Object.values(parts).some((d) => /^Engines · table: Model, Years.*Top speed/.test(d)), 'the part is offered with its column names');
  const pieces = Object.values(jev.requests.at(-1).questions.refine.criteria);
  assert.ok(pieces.includes('Model: 1.6 litre VTi 16v') && pieces.includes('Top speed: 187 km/h (116 mph)'));
  assert.ok(!pieces.some((p) => /Petrol engines/.test(p)), 'the group name is not a piece');
});

test('a wrong row that Jev picked is turned down by the check, and the right one after it is found', async () => {
  const c4 = () => ({ title: 'C4', disambiguation: false, infobox: [], sections: [{ path: 'Engines', anchor: 'Engines', sentences: [], tables: [{ caption: '', headers: ['Model', 'Top speed'], rows: ['Model: THP • Top speed: 210 km/h', 'Model: VTi • Top speed: 187 km/h', 'Model: HDi • Top speed: 180 km/h'] }] }] });
  const jev = fakeJev({
    term: (q) => ({ [keyFor(q.criteria, 'C4')]: 0.9 }),
    article: (q) => ({ [keyFor(q.criteria, /^C4: /)]: 0.9 }),
    part: (q) => ({ [keyFor(q.criteria, /^Engines/)]: 0.95 }),
    answer: (q) => ({ [keyFor(q.criteria, /THP/)]: 0.5, [keyFor(q.criteria, /VTi/)]: 0.4 }), // Jev prefers the wrong row
    check: (request) => (/VTi/.test(request.state.sentence) ? 0.96 : 0.08), // ... but the exact check knows
  });
  const world = fakeWorld({ results: [{ title: 'C4', snippet: 'x' }], pages: { C4: c4() } });
  const result = await refined('what is the top speed of the C4 VTi?', { ...world, run: jev.run });
  assert.equal(result.status, 'found');
  assert.match(result.answer.text, /VTi/);
  assert.equal(result.answer.refined, 'Model: VTi', 'the fake refine picks the first piece');
  const checks = result.trail.filter((s) => s.id === 'check').map((s) => s.p);
  assert.deepEqual(checks, [0.08, 0.96]);
});
