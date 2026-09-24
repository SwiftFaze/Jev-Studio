import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest } from '../src/validate.js';
import { QUESTION_TYPE_CRITERIA } from '../public/lib/wikipedia.js';
import { findAnswer } from '../public/lib/wikipedia-run.js';

// Step 0 (classification, the false-premise/unanswerable gates, and the Multi-Part/Comparison/Negation routing it can
// lead to) is exercised here, apart from the single-entity pipeline's own tests, which run with `classify: false` and
// are unaffected by any of this.

const page = (title, sentences = ['A sentence about it.']) => ({ title, disambiguation: false, infobox: [], sections: [{ path: 'Lead', anchor: '', sentences }] });
const notFound = async () => {
  throw Object.assign(new Error('not found'), { status: 404 });
};

/**
 * A pretend Jev for these tests: validates every request as the real server would, then answers each question by its
 * id from `rules` (a value, or a function of `(question, request)`). A Choice with no rule for its id splits evenly;
 * a Noul with no rule answers a confident "no" (0.03), so gates and routing stay closed unless a test opens them.
 */
function fakeJev(rules = {}) {
  const requests = [];
  const run = async (request) => {
    const check = validateRequest(request);
    assert.equal(check.ok, true, JSON.stringify(check.errors));
    requests.push(request);
    const answers = {};
    for (const [id, q] of Object.entries(request.questions)) {
      const rule = rules[id];
      const given = typeof rule === 'function' ? rule(q, request) : rule;
      if (q.type === 'noul') {
        answers[id] = { type: 'noul', noul: given ?? 0.03 };
        continue;
      }
      const keys = Object.keys(q.criteria);
      const picked = given ?? {};
      const taken = Object.values(picked).reduce((a, b) => a + b, 0);
      const rest = keys.filter((k) => !(k in picked));
      const probabilities = Object.fromEntries(keys.map((k) => [k, k in picked ? picked[k] : rest.length ? Math.max(0, 1 - taken) / rest.length : 0]));
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
      answers[id] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
    }
    return { answers, usage: { input_tokens: 10, output_tokens: 5 } };
  };
  return { run, requests, ids: () => requests.flatMap((r) => Object.keys(r.questions)) };
}

/** Rules for step 0 alone: a confident type, and both gates closed unless overridden. */
const classifyAs = (type, extra = {}) => ({ type: () => ({ [type]: 0.9 }), ...extra });

/** Rules for the single-entity pipeline (term/article/part/answer/check), answering with one page and one sentence. */
const singleEntity = (sentence = 'The answer is here.') => ({
  article: () => ({ a0: 0.9 }),
  part: () => ({ p0: 0.9 }),
  meaning: () => ({ fact: 0.5 }),
  answer0: () => ({ c0: 0.9 }),
  answers: 0.9,
});

test('every question type is a valid Choice option, and there are no duplicates', () => {
  const keys = Object.keys(QUESTION_TYPE_CRITERIA);
  assert.ok(keys.length >= 15, 'the appendix has at least 15 types');
  assert.equal(new Set(keys).size, keys.length);
  for (const desc of Object.values(QUESTION_TYPE_CRITERIA)) assert.ok(desc.length > 20, 'each has a real definition, not a stub');
});

test('classification runs as step 0, then a Direct-Fact question goes through the single-entity pipeline unchanged', async () => {
  const jev = fakeJev({ ...classifyAs('direct-fact'), falsePremise: 0.03, unanswerable: 0.03, ...singleEntity() });
  const result = await findAnswer('Who was the first person on the Moon?', {
    search: async () => ({ results: [{ title: 'Neil Armstrong', snippet: 'x' }] }),
    article: async () => page('Neil Armstrong'),
    run: jev.run,
    classify: true,
  });
  assert.equal(result.status, 'found');
  assert.equal(result.trail[0].id, 'classify');
  assert.equal(result.trail[0].label, 'Direct Fact');
  assert.equal(result.trail[1].id, 'gate');
  assert.deepEqual(jev.ids().slice(0, 3), ['type', 'falsePremise', 'unanswerable'], 'one request for step 0, before the term step');
});

test('step 0\'s "what does it ask for" steers which PART is chosen, not just which sentence: an infobox of raw facts loses to the Lead for a "what is X" question', async () => {
  // The exact shape of the bug report this fixes: an infobox of unrelated facts (Developer, Type, ...) with no
  // explanation of what the subject actually is, and a Lead that has one.
  const article = {
    title: 'Jev (AI model)',
    disambiguation: false,
    infobox: [
      { label: 'Developer', value: 'TypeSafe AI' },
      { label: 'Type', value: 'Artificial intelligence model' },
    ],
    sections: [{ path: 'Lead', anchor: '', sentences: ['Jev is TypeSafe’s AI model for turning natural language into typed judgments.'] }],
  };
  let partRequestSeen = null;
  const jev = fakeJev({
    ...classifyAs('direct-fact', { meaning: () => ({ explanation: 0.7, fact: 0.2 }) }),
    falsePremise: 0.02,
    unanswerable: 0.02,
    article: () => ({ a0: 0.9 }),
    part: (q, request) => {
      partRequestSeen = request;
      return { p1: 0.9 }; // the Lead (p1), now that the request itself says what kind of thing is being asked for
    },
    answer0: () => ({ c0: 0.9 }),
    answers: 0.9,
  });
  const result = await findAnswer('what is jev ai typesafe', {
    search: async () => ({ results: [{ title: 'Jev (AI model)', snippet: 'x' }] }),
    article: async () => article,
    run: jev.run,
    classify: true,
  });
  assert.equal(result.status, 'found');
  assert.match(result.answer.text, /turning natural language/, 'the Lead was picked, not an infobox row');
  assert.match(partRequestSeen.questions.part.instructions, /which is asking for an explanation or a description\?$/);
  assert.equal('meaning' in partRequestSeen.questions, false, 'settled once in step 0, not asked again for this (or any other) article');
  assert.equal(result.trail.filter((s) => s.id === 'meaning').length, 1, '"what it asks for" appears once, as its own step 0 entry');
  assert.equal(result.trail.find((s) => s.id === 'part').meaning, undefined, 'no longer duplicated nested under the part step');
});

test('classify: false (the default in the rest of the test suite) skips step 0 entirely', async () => {
  const jev = fakeJev(singleEntity());
  const result = await findAnswer('Who was the first person on the Moon?', {
    search: async () => ({ results: [{ title: 'Neil Armstrong', snippet: 'x' }] }),
    article: async () => page('Neil Armstrong'),
    run: jev.run,
    classify: false,
  });
  assert.equal(result.status, 'found');
  assert.ok(!result.trail.some((s) => s.id === 'classify'));
});

test('a confident false-premise gate returns "false-premise" and skips retrieval entirely', async () => {
  let searched = false;
  const jev = fakeJev({ ...classifyAs('false-premise'), falsePremise: 0.92, unanswerable: 0.02 });
  const result = await findAnswer('How tall is the city of Chicago?', {
    search: async () => {
      searched = true;
      return { results: [] };
    },
    article: notFound,
    run: jev.run,
    classify: true,
  });
  assert.equal(result.status, 'false-premise');
  assert.equal(searched, false, 'no search was made once the gate closed');
  assert.equal(result.requests, 1, 'the one request for step 0, nothing more');
});

test('a confident unanswerable gate returns "unanswerable" and skips retrieval entirely', async () => {
  let searched = false;
  const jev = fakeJev({ ...classifyAs('unanswerable'), falsePremise: 0.02, unanswerable: 0.88 });
  const result = await findAnswer('purple November maybe river', {
    search: async () => {
      searched = true;
      return { results: [] };
    },
    article: notFound,
    run: jev.run,
    classify: true,
  });
  assert.equal(result.status, 'unanswerable');
  assert.equal(searched, false);
});

test('below the gate threshold, retrieval proceeds as normal even with some false-premise/unanswerable probability', async () => {
  const jev = fakeJev({ ...classifyAs('attribute'), falsePremise: 0.4, unanswerable: 0.1, ...singleEntity() });
  const result = await findAnswer("What is Japan's population?", {
    search: async () => ({ results: [{ title: 'Japan', snippet: 'x' }] }),
    article: async () => page('Japan'),
    run: jev.run,
    classify: true,
  });
  assert.equal(result.status, 'found');
});

test('Multi-Part: the question is split, the second part\'s pronoun is resolved to the first part\'s entity, and the answers are joined', async () => {
  const question = 'What is the longest river in South America, and which countries does it pass through?';
  const jev = fakeJev({
    ...classifyAs('multi-part'),
    falsePremise: 0.02,
    unanswerable: 0.02,
    article: (q, request) => {
      const wantsRiver = /longest river/i.test(request.state.question);
      return wantsRiver ? { a0: 0.9 } : { a0: 0.9 };
    },
    part: () => ({ p0: 0.9 }),
    meaning: () => ({ fact: 0.5 }),
    answer0: (q, request) => (/countries/i.test(request.state.question) ? { c0: 0.9 } : { c0: 0.9 }),
    answers: (q, request) => (/Amazon River/.test(request.state.article) ? 0.9 : 0.9),
  });
  const pages = { 'Amazon River': page('Amazon River', ['The Amazon is the longest river in South America.']) };
  const result = await findAnswer(question, {
    search: async (query) => ({ results: [{ title: query.includes('countries') ? 'Amazon River' : 'Amazon River', snippet: 'x' }] }),
    article: async (title) => pages[title] ?? page(title, [`${title} passes through Brazil, Peru and Colombia.`]),
    run: jev.run,
    classify: true,
  });
  assert.equal(result.status, 'found');
  assert.ok(result.answer.text.includes('1. '));
  assert.ok(result.answer.text.includes('2. '));
  assert.ok(result.answer.parts.length === 2);
  const subquestions = result.trail.filter((s) => s.id === 'subquestion');
  assert.equal(subquestions.length, 2);
  assert.match(subquestions[1].label, /does Amazon River pass through/, 'the pronoun in part 2 was resolved to part 1\'s entity');
});

test('Multi-Part: when the question cannot be split with confidence, it falls back to the single-entity pipeline instead of guessing', async () => {
  const jev = fakeJev({ ...classifyAs('multi-part'), falsePremise: 0.02, unanswerable: 0.02, ...singleEntity() });
  const result = await findAnswer('What is the capital of France?', {
    search: async () => ({ results: [{ title: 'France', snippet: 'x' }] }),
    article: async () => page('France'),
    run: jev.run,
    classify: true,
  });
  assert.equal(result.status, 'found', 'the single-entity pipeline still ran, since there was nothing to split');
  assert.ok(!result.trail.some((s) => s.id === 'subquestion'));
});

test('Comparison: both entities are looked up independently, then Jev decides the comparison from the two facts found', async () => {
  const question = 'Which has more surface area, Canada or China?';
  const jev = fakeJev({
    ...classifyAs('comparison'),
    falsePremise: 0.02,
    unanswerable: 0.02,
    article: () => ({ a0: 0.9 }),
    part: () => ({ p0: 0.9 }),
    meaning: () => ({ fact: 0.5 }),
    answer0: (q, request) => ({ [/Canada/.test(request.state.article) ? 'c0' : 'c0']: 0.9 }),
    answers: 0.9,
    compare: () => ({ e0: 0.15, e1: 0.8 }), // China (e1) wins
  });
  const facts = { Canada: '9,984,670 km2.', China: '9,596,960 km2.' };
  const result = await findAnswer(question, {
    search: async (query) => ({ results: [{ title: /Canada/.test(query) ? 'Canada' : 'China', snippet: 'x' }] }),
    article: async (title) => page(title, [facts[title]]),
    run: jev.run,
    classify: true,
  });
  assert.equal(result.status, 'found');
  assert.match(result.answer.text, /^China/);
  assert.equal(result.answer.compared.length, 2);
  const compared = result.trail.find((s) => s.id === 'compare');
  assert.ok(compared);
  assert.match(compared.label, /China has more surface area/);
});

test('Comparison: when the question does not match a recognised pattern, it falls back rather than guessing at entities', async () => {
  const jev = fakeJev({ ...classifyAs('comparison'), falsePremise: 0.02, unanswerable: 0.02, ...singleEntity() });
  const result = await findAnswer('How do Canada and China compare economically?', {
    search: async () => ({ results: [{ title: 'Economy comparison', snippet: 'x' }] }),
    article: async () => page('Economy comparison'),
    run: jev.run,
    classify: true,
  });
  assert.equal(result.status, 'found', 'fell back to the single-entity pipeline');
});

test('Negation: candidates are enumerated from a "List of…" article and filtered with one batched Yes/No, keeping the sole "no"', async () => {
  const question = 'Which U.S. state has never held a presidential primary?';
  const candidatesArticle = {
    title: 'List of U.S. states',
    disambiguation: false,
    infobox: [],
    sections: [{ path: 'Lead', anchor: '', sentences: ['Wyoming: a state.', 'California: a state.', 'Texas: a state.'] }],
  };
  const jev = fakeJev({
    ...classifyAs('negation'),
    falsePremise: 0.02,
    unanswerable: 0.02,
    n0: 0.05, // Wyoming: "has held a presidential primary" is very unlikely — this is the one that satisfies the negation
    n1: 0.9, // California: has
    n2: 0.85, // Texas: has
  });
  const result = await findAnswer(question, {
    search: async (query) => {
      assert.equal(query, 'List of U.S. states');
      return { results: [{ title: 'List of U.S. states', snippet: 'x' }] };
    },
    article: async () => candidatesArticle,
    run: jev.run,
    classify: true,
  });
  assert.equal(result.status, 'found');
  assert.equal(result.answer.text, 'Wyoming');
  const filterRequest = jev.requests.find((r) => 'n0' in r.questions);
  assert.equal(Object.keys(filterRequest.questions).length, 3, 'one batched request, one Yes/No per candidate');
  assert.match(filterRequest.questions.n0.instructions, /Has Wyoming held a presidential primary\?/);
});

test('Negation: zero or more than one passing candidate is reported as not found, rather than guessing', async () => {
  const candidatesArticle = {
    title: 'List of U.S. states',
    disambiguation: false,
    infobox: [],
    sections: [{ path: 'Lead', anchor: '', sentences: ['Wyoming: a state.', 'California: a state.'] }],
  };
  const world = {
    search: async () => ({ results: [{ title: 'List of U.S. states', snippet: 'x' }] }),
    article: async () => candidatesArticle,
    classify: true,
  };

  const none = fakeJev({ ...classifyAs('negation'), falsePremise: 0.02, unanswerable: 0.02, n0: 0.9, n1: 0.9 });
  const noneResult = await findAnswer('Which U.S. state has never held a presidential primary?', { ...world, run: none.run });
  assert.equal(noneResult.status, 'not-found');
  assert.match(noneResult.reason, /None of the/);

  const both = fakeJev({ ...classifyAs('negation'), falsePremise: 0.02, unanswerable: 0.02, n0: 0.05, n1: 0.05 });
  const bothResult = await findAnswer('Which U.S. state has never held a presidential primary?', { ...world, run: both.run });
  assert.equal(bothResult.status, 'not-found');
  assert.match(bothResult.reason, /2 candidates satisfied/);
});

test('Negation: falls back to false when the question\'s subject cannot be identified', async () => {
  const jev = fakeJev({ ...classifyAs('negation'), falsePremise: 0.02, unanswerable: 0.02, ...singleEntity() });
  const result = await findAnswer('Something that never happened, apparently', {
    search: async () => ({ results: [{ title: 'Something', snippet: 'x' }] }),
    article: async () => page('Something'),
    run: jev.run,
    classify: true,
  });
  assert.equal(result.status, 'found', 'fell back to the single-entity pipeline, since there was no subject to enumerate');
});
