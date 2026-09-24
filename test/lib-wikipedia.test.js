import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRequest } from '../src/validate.js';
import {
  articleParts, articleUrl, buildAnswerRequest, buildArticleRequest, buildCheckRequest, buildPartRequest, buildRefineRequest, buildTermRequest, rowPieces, decodeEntities, leadExcerpt, ABOUT_CHARS, MAX_CHOICES,
  addSavedAnswer, cleanSavedAnswers, cleanStats, cleanTrail, mergeResults, mergeTables, parseTables, meaningOptions, parseInfobox, partCandidates, readAnswerChunks, readChoice, readMeaning, readYesNo, savedAnswer, searchTerms, splitSections, splitSentences, stripSnippet,
} from '../public/lib/wikipedia.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/wikipedia/${name}`, import.meta.url), 'utf8'));
const parisExtract = () => fixture('extract-paris.json').query.pages[0].extract;
const parisHtml = () => fixture('parse-paris.json').parse.text;

/* ---------- links ---------- */

test('articleUrl is always on the one host, encodes what needs it and keeps brackets readable', () => {
  assert.equal(articleUrl('Paris'), 'https://en.wikipedia.org/wiki/Paris');
  assert.equal(articleUrl('Mount Everest', 'Elevation'), 'https://en.wikipedia.org/wiki/Mount_Everest#Elevation');
  assert.equal(articleUrl('Mercury (planet)'), 'https://en.wikipedia.org/wiki/Mercury_(planet)');
  assert.equal(articleUrl('AC/DC'), 'https://en.wikipedia.org/wiki/AC%2FDC');
  assert.equal(articleUrl('x?evil=1#frag'), 'https://en.wikipedia.org/wiki/x%3Fevil%3D1%23frag');
  assert.equal(new URL(articleUrl('//evil.example/x')).origin, 'https://en.wikipedia.org');
});

/* ---------- step 1 ---------- */

test('searchTerms starts with the question as typed and includes the names in it', () => {
  const terms = searchTerms('How big is Paris?');
  assert.equal(terms[0], 'How big is Paris?');
  assert.ok(terms.includes('Paris'));
});

test('searchTerms drops question words and filler, and finds each capitalised name', () => {
  assert.deepEqual(searchTerms('How tall is Mount Everest?'), ['How tall is Mount Everest?', 'Mount Everest']);
  assert.ok(searchTerms('Who wrote Frankenstein?').includes('Frankenstein'));
  const eiffel = searchTerms('When was the Eiffel Tower finished?');
  assert.ok(eiffel.includes('Eiffel Tower'), 'the leading "the" is not part of the name');
  assert.ok(searchTerms('What is the Lord of the Rings about?').includes('Lord of the Rings'), 'connecting words stay inside a name');
});

test('searchTerms works on a question typed in lower case, has no repeats, and is capped at ten', () => {
  assert.deepEqual(searchTerms('how old is mercury'), ['how old is mercury', 'mercury']);
  const terms = searchTerms('Paris paris PARIS');
  assert.equal(new Set(terms.map((t) => t.toLowerCase())).size, terms.length);
  const long = searchTerms(Array.from({ length: 30 }, (_, i) => `Word${i} of Other${i} and thing${i}`).join(' '));
  assert.ok(long.length <= 10);
});

test('searchTerms gives nothing for an empty question, and never gives an empty term', () => {
  assert.deepEqual(searchTerms(''), []);
  assert.deepEqual(searchTerms('   '), []);
  assert.deepEqual(searchTerms(null), []);
  assert.deepEqual(searchTerms('what is it?'), ['what is it?'], 'all filler: only the question itself is left');
  for (const q of ['What?!', '???', 'the of and']) assert.ok(searchTerms(q).every((t) => t.trim() !== ''), q);
});

/* ---------- text out of Wikipedia's replies ---------- */

test('decodeEntities handles named, decimal and hex entities, and leaves unknown ones alone', () => {
  assert.equal(decodeEntities('a&nbsp;b &amp; c &quot;d&quot; &#160;e&#x27;f &#8211; &bogus; &#0;'), 'a b & c "d"  e\'f – &bogus; &#0;');
  assert.equal(decodeEntities('&amp;lt;'), '&lt;', 'decoded once, not twice');
});

test('stripSnippet drops the searchmatch spans, decodes entities, and removes footnote marks', () => {
  const html = '<span class="searchmatch">Paris</span> is the capital, with an area of 105.4&nbsp;km2 (40.7 sq mi), as of January 2026[update] &quot;City of Light&quot;';
  assert.equal(stripSnippet(html), 'Paris is the capital, with an area of 105.4 km2 (40.7 sq mi), as of January 2026 "City of Light"');
  assert.equal(stripSnippet(undefined), '');
  assert.doesNotMatch(stripSnippet('<script>alert(1)</script>x <b onclick="y">z</b>'), /<|>/);
});

/* ---------- sections ---------- */

test('splitSections reads the lead as the first section, and nested headings as paths', () => {
  const sections = splitSections(parisExtract());
  assert.deepEqual(sections.map((s) => s.path), ['Lead', 'Etymology', 'Geography', 'Geography › Climate', 'Demographics', 'Demographics › Migration', 'Demographics › Religion']);
  assert.equal(sections[0].anchor, '');
  assert.match(sections[0].text, /^Paris is the capital and largest city of France/);
  assert.deepEqual(sections.slice(2, 4).map((s) => s.anchor), ['Geography', 'Climate']);
  assert.doesNotMatch(sections[2].text, /==/, 'headings are not left in the text');
  assert.doesNotMatch(sections[2].text, /Climate/i, 'a section holds its own text, not its subsections\'');
});

test('splitSections handles levels, spaces in anchors, empty sections and the ends of an article', () => {
  const text = 'Lead text.\n\n== History ==\nOld.\n=== Early years ===\nEarlier.\n=== Later ===\n\n== Culture ==\nArt.\n\n== References ==\nNot wanted.\n';
  const sections = splitSections(text);
  assert.deepEqual(sections.map((s) => [s.path, s.anchor, s.level]), [['Lead', '', 1], ['History', 'History', 2], ['History › Early years', 'Early_years', 3], ['Culture', 'Culture', 2]]);
  assert.deepEqual(splitSections(''), []);
  assert.deepEqual(splitSections('== Only a heading ==').length, 0);
  const sibling = splitSections('== A ==\na\n=== B ===\nb\n== C ==\nc');
  assert.equal(sibling.at(-1).path, 'C', 'a heading of the level above closes the one below');
});

/* ---------- sentences ---------- */

test('splitSentences keeps decimals, abbreviations and initials together, and drops footnote marks', () => {
  const sentences = splitSentences('Paris has an area of 105.4 km2 (40.7 sq mi). It is in France.[3] Mount St. Helens rose c. 2,549 m above sea level. J. R. R. Tolkien wrote it.[a] Done[citation needed].');
  assert.deepEqual(sentences, [
    'Paris has an area of 105.4 km2 (40.7 sq mi).',
    'It is in France.',
    'Mount St. Helens rose c. 2,549 m above sea level.',
    'J. R. R. Tolkien wrote it.',
    'Done.',
  ]);
});

test('splitSentences reads each line on its own, and skips empty lines', () => {
  assert.deepEqual(splitSentences('First line\n\nSecond line. Third.\n   \nFourth'), ['First line', 'Second line.', 'Third.', 'Fourth']);
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences(undefined), []);
});

test('splitSentences joins a stray mid-sentence newline (where a citation reference used to be) back into one sentence', () => {
  // Confirmed live against Wikipedia's real extract for one article: "...confidence\nscores. Its output..." — a bare
  // newline was left where a footnote reference had been, splitting "confidence scores." into two ungrammatical
  // fragments ("confidence" and "scores.") that then became a truncated final answer.
  assert.deepEqual(
    splitSentences('It returns probability estimates and confidence\nscores. Its output is read by a\nperson. \nA new paragraph starts here.'),
    ['It returns probability estimates and confidence scores.', 'Its output is read by a person.', 'A new paragraph starts here.'],
  );
  // A line ending in punctuation, or one followed by an uppercase start, is a real break — not joined.
  assert.deepEqual(splitSentences('Ends here.\nStarts here'), ['Ends here.', 'Starts here']);
  assert.deepEqual(splitSentences('No stop\nStarts uppercase.'), ['No stop', 'Starts uppercase.']);
});

test('splitSentences on the Paris lead keeps the sentence with the area whole', () => {
  const [first] = splitSentences(splitSections(parisExtract())[0].text);
  assert.match(first, /an area of 105\.4 km2 \(40\.7 sq mi\), as of January 2026, and a metropolitan population of 13\.3 million \(2023\)\.$/);
});

/* ---------- the infobox ---------- */

test('parseInfobox reads the rows of the Paris infobox as text, with the Area row folded into one', () => {
  const rows = parseInfobox(parisHtml());
  assert.ok(rows.length >= 10);
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel.Area, '105.4 km2 (40.7 sq mi) • Urban 2,824.2 km2 (1,090.4 sq mi) • Metro 18,940.7 km2 (7,313.0 sq mi)');
  assert.equal(byLabel.Country, 'France');
  assert.match(byLabel['Population (Jan 2026)'], /^2,0\d\d,\d{3} • /);
  assert.match(byLabel.Elevation, /^28–131 m \(92–430 ft\)/);
});

test('parseInfobox leaves out footnote marks, styles, pictures, headings and markup', () => {
  const rows = parseInfobox(parisHtml());
  const everything = JSON.stringify(rows);
  assert.doesNotMatch(everything, /<|>|&#|&nbsp;|\.mw-parser-output|cite_note|\[\d+\]/);
  assert.ok(rows.every((r) => r.label && r.value), 'no empty rows');
  assert.ok(!rows.some((r) => /^(Government|Capital city)$/.test(r.label)), 'headings are not rows');
});

test('parseInfobox copes with nested tables, sub-rows, an empty result and junk', () => {
  const html =
    '<div><table class="infobox"><tbody>' +
    '<tr><th colspan="2">Heading</th></tr>' +
    '<tr><th>Height<sup>1</sup></th><td>8,849 m<sup class="reference">[2]</sup> (29,032&#160;ft)<style>.x{color:red}</style></td></tr>' +
    '<tr><th>&#160;•&#160;Base</th><td>5,364 m</td></tr>' +
    '<tr><th>Hidden</th><td><span style="display:none">secret</span></td></tr>' +
    '<tr><th>Nested</th><td><table><tr><th>Inner</th><td>inner</td></tr></table>outer</td></tr>' +
    '</tbody></table><table><tr><th>Other</th><td>x</td></tr></table></div>';
  assert.deepEqual(parseInfobox(html), [
    { label: 'Height', value: '8,849 m (29,032 ft) • Base 5,364 m' },
    { label: 'Nested', value: 'Inner inner outer' },
  ]);
  assert.deepEqual(parseInfobox('<p>No box here</p>'), []);
  assert.deepEqual(parseInfobox(''), []);
  assert.deepEqual(parseInfobox(undefined), []);
  assert.doesNotThrow(() => parseInfobox('<table class="infobox"><tr><th>Broken<td>unclosed'));
  assert.deepEqual(parseInfobox('<table class="infobox"><tr><th>•&#160;Only a part</th><td>1</td></tr></table>'), [{ label: 'Only a part', value: '1' }]);
});

/* ---------- search results ---------- */

test('mergeResults goes rank by rank, drops repeats and disambiguation pages, and caps the list', () => {
  const a = [{ title: 'Paris', snippet: 'a' }, { title: 'Paris (disambiguation)', snippet: '' }, { title: 'Paris, Texas', snippet: 'b' }];
  const b = [{ title: 'paris', snippet: 'dup' }, { title: 'Île-de-France', snippet: 'c' }];
  assert.deepEqual(mergeResults([a, b]).map((r) => r.title), ['Paris', 'Île-de-France', 'Paris, Texas']);
  assert.equal(mergeResults([Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, snippet: '' }))]).length, 12);
  assert.deepEqual(mergeResults([]), []);
});

/* ---------- the questions asked of Jev ---------- */

const parisArticle = () => ({
  title: 'Paris',
  infobox: parseInfobox(parisHtml()),
  sections: splitSections(parisExtract()).map((s) => ({ path: s.path, anchor: s.anchor, sentences: splitSentences(s.text) })),
});

const OK = (request, label) => assert.equal(validateRequest(request).ok, true, `${label}: ${JSON.stringify(validateRequest(request).errors)}`);

test('meaningOptions depends on the question, always has 2 or more options, and ends with an "other" way out', () => {
  assert.deepEqual(Object.keys(meaningOptions('How big is Paris?')), ['area', 'population', 'both', 'other']);
  assert.ok('height' in meaningOptions('How tall is Mount Everest?'));
  assert.ok('age' in meaningOptions('How old is Mercury?'));
  assert.ok('person' in meaningOptions('Who wrote Frankenstein?'));
  assert.ok('start' in meaningOptions('When was the Eiffel Tower finished?'));
  for (const q of ['', 'Tell me about it', 'Why is the sky blue?', 'How many people live in Paris?']) {
    const options = meaningOptions(q);
    assert.ok(Object.keys(options).length >= 2, q);
    assert.ok('other' in options, q);
  }
});

test('the term request is a valid Choice whose keys map back to the terms', () => {
  const terms = searchTerms('How big is Paris?');
  const request = buildTermRequest('How big is Paris?', terms);
  OK(request, 'term');
  assert.deepEqual(Object.values(request.questions.term.criteria), terms);
  const { ranked } = readChoice({ probabilities: { t0: 0.1, t1: 0.9 } }, terms, 't');
  assert.equal(ranked[0].item, 'Paris');
});

test('the article request has a Choice with a "none", and a Yes / No for each snippet', () => {
  const results = [{ title: 'Paris', snippet: 'Paris is the capital of France.' }, { title: 'Paris, Texas', snippet: 'A city in Texas.' }];
  const request = buildArticleRequest('How big is Paris?', results);
  OK(request, 'article');
  assert.deepEqual(Object.keys(request.questions.article.criteria), ['a0', 'a1', 'none']);
  assert.match(request.questions.article.criteria.a0, /^Paris: Paris is the capital/);
  assert.equal(request.questions.s0.type, 'noul');
  assert.match(request.questions.s1.instructions, /Paris, Texas/);
  assert.equal(request.state.question, 'How big is Paris?');
});

test('the part request lists the infobox with its row labels, then the sections, and asks the meaning too', () => {
  const parts = articleParts(parisArticle());
  assert.equal(parts[0].label, 'Infobox');
  assert.match(parts[0].description, /^Infobox: Country, Region.*Area.*Population/);
  assert.deepEqual(parts.slice(1, 4).map((p) => p.label), ['Lead', 'Etymology', 'Geography']);
  const request = buildPartRequest('How big is Paris?', 'Paris', parts);
  OK(request, 'part');
  assert.equal(request.questions.part.criteria.p0, parts[0].description);
  assert.equal(request.questions.part.criteria[`p${parts.length - 1}`], parts.at(-1).description);
  assert.ok('none' in request.questions.part.criteria);
  assert.deepEqual(Object.keys(request.questions.meaning.criteria), ['area', 'population', 'both', 'other']);
  assert.deepEqual(request.state, { question: 'How big is Paris?', article: 'Paris' });
});

test('given step 0\'s meaning, the part request folds it into the instructions and does not ask it again', () => {
  const parts = articleParts(parisArticle());
  const request = buildPartRequest('How big is Paris?', 'Paris', parts, 'Its land area');
  OK(request, 'part with meaning');
  assert.equal(request.questions.part.instructions, 'Which part of the article `article` is most likely to state the answer to `question`, which is asking for its land area?');
  assert.equal('meaning' in request.questions, false, 'not asked again: step 0 already answered it, once, for every article');
});

test('an article with no infobox has no Infobox part, and a very long article is cut to what a Choice allows', () => {
  const noBox = articleParts({ title: 'X', infobox: [], sections: [{ path: 'Lead', anchor: '', sentences: ['One.'] }] });
  assert.deepEqual(noBox.map((p) => p.label), ['Lead']);
  const huge = articleParts({ title: 'X', infobox: [{ label: 'A', value: 'b' }], sections: Array.from({ length: 400 }, (_, i) => ({ path: `S${i}`, anchor: `S${i}`, sentences: ['x.'] })) });
  assert.equal(huge.length, MAX_CHOICES);
  OK(buildPartRequest('q', 'X', huge), 'huge');
});

test('partCandidates gives an infobox row as "Label: value", and a sentence with its neighbours; long ones are cut to 400', () => {
  const parts = articleParts(parisArticle());
  const area = partCandidates(parts[0]).find((c) => c.text.startsWith('Area: '));
  assert.match(area.text, /^Area: 105\.4 km2 \(40\.7 sq mi\) • Urban/);
  assert.equal(area.before, '');
  const lead = partCandidates(parts[1]);
  assert.equal(lead[0].before, '');
  assert.equal(lead[1].before, lead[0].text);
  assert.equal(lead[0].after, lead[1].text);
  const long = partCandidates({ kind: 'section', sentences: ['x'.repeat(1000)] })[0];
  assert.equal(long.text.length, 400);
  assert.ok(long.text.endsWith('…'));
});

test('the answer request keeps to 250 options a Choice, in chunks, each with its own "none"', () => {
  const candidates = Array.from({ length: 600 }, (_, i) => ({ text: `Sentence ${i}.`, before: '', after: '' }));
  const { request, chunks } = buildAnswerRequest('q', 'Paris', 'History', candidates);
  OK(request, 'answer');
  assert.deepEqual(chunks.map((c) => c.length), [250, 250, 100]);
  assert.deepEqual(Object.keys(request.questions), ['answer0', 'answer1', 'answer2']);
  for (const q of Object.values(request.questions)) {
    assert.ok(Object.keys(q.criteria).length <= 255);
    assert.ok('none' in q.criteria);
  }
  assert.equal(request.questions.answer1.criteria.c0, 'Sentence 250.');
  const one = buildAnswerRequest('q', 'Paris', 'Lead', candidates.slice(0, 1));
  OK(one.request, 'one candidate and a none is still a Choice');
  const enormous = buildAnswerRequest('q', 'Paris', 'Lead', Array.from({ length: 5000 }, () => candidates[0]));
  assert.equal(enormous.chunks.length, 4, 'a part is cut off after four chunks');
});

test('the answer request writes the question, article and part into the instructions itself, not as `backtick` placeholders (confirmed live to rank far more decisively); `state` still carries them, for the trail and "Open in Single"', () => {
  const candidates = [{ text: 'Sentence.', before: '', after: '' }];
  const plain = buildAnswerRequest('How big is Paris?', 'Paris', 'History', candidates);
  assert.equal(plain.request.questions.answer0.instructions, 'Which of these sentences, from the part "History" of the article "Paris", states the answer to "How big is Paris?"?');
  assert.deepEqual(plain.request.state, { question: 'How big is Paris?', article: 'Paris', part: 'History' });

  const withMeaning = buildAnswerRequest('How big is Paris?', 'Paris', 'History', candidates, 'An explanation or a description');
  OK(withMeaning.request, 'answer request with meaning');
  assert.equal(
    withMeaning.request.questions.answer0.instructions,
    'Which of these sentences, from the part "History" of the article "Paris", is an explanation or a description for "How big is Paris?"?',
  );
});

test('readAnswerChunks puts every candidate in one list, best first, each with its chunk\'s none', () => {
  const chunks = [[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }]];
  const answers = {
    answer0: { probabilities: { c0: 0.2, c1: 0.5, none: 0.3 } },
    answer1: { probabilities: { c0: 0.6, none: 0.4 } },
  };
  const all = readAnswerChunks(answers, chunks);
  assert.deepEqual(all.map((r) => [r.item.text, r.p, r.none]), [['c', 0.6, 0.4], ['b', 0.5, 0.3], ['a', 0.2, 0.3]]);
});

test('the check request carries the sentence and its neighbours, and leaves out empty ones', () => {
  const both = buildCheckRequest('q', 'Paris', 'Lead', { text: 'S', before: 'B', after: 'A' });
  OK(both, 'check');
  assert.deepEqual(both.state, { question: 'q', article: 'Paris', part: 'Lead', sentence: 'S', before: 'B', after: 'A' });
  const bare = buildCheckRequest('q', 'Paris', 'Infobox', { text: 'S', before: '', after: '' });
  assert.deepEqual(Object.keys(bare.state), ['question', 'article', 'part', 'sentence']);
});

test('leadExcerpt joins sentences up to ABOUT_CHARS, and is null for nothing to join', () => {
  assert.equal(leadExcerpt(undefined), null);
  assert.equal(leadExcerpt([]), null);
  assert.equal(leadExcerpt(['One.', 'Two.']), 'One. Two.');
  const long = leadExcerpt(Array.from({ length: 100 }, () => 'A sentence of a certain length.'));
  assert.equal(long.length, ABOUT_CHARS);
  assert.ok(long.endsWith('…'));
});

test('an infobox or table row, with no before/after of its own, gets the Lead as `about` instead; the Lead itself does not repeat itself', () => {
  const about = 'Paris is the capital of France.';
  const withAbout = buildAnswerRequest('q', 'Paris', 'Infobox', [{ text: 'Area: 105 km2' }], null, about);
  assert.equal(withAbout.request.state.about, about);
  assert.match(withAbout.request.questions.answer0.instructions, /`about` is a short excerpt/);
  const withoutAbout = buildAnswerRequest('q', 'Paris', 'Lead', [{ text: 'Paris is a city.' }]);
  assert.equal('about' in withoutAbout.request.state, false);
  assert.doesNotMatch(withoutAbout.request.questions.answer0.instructions, /about/);

  const check = buildCheckRequest('q', 'Paris', 'Infobox', { text: 'Area: 105 km2', before: '', after: '' }, about);
  assert.equal(check.state.about, about);
  assert.match(check.questions.answers.instructions, /`about` is a short excerpt/);
});

/* ---------- reading answers ---------- */

test('readChoice ranks every item, ties in order, and copes with a partial or missing answer', () => {
  const items = ['x', 'y', 'z'];
  const full = readChoice({ choice: 'p1', probabilities: { p0: 0.1, p1: 0.7, p2: 0.1, none: 0.1 } }, items, 'p');
  assert.deepEqual(full.ranked.map((r) => r.item), ['y', 'x', 'z']);
  assert.equal(full.none, 0.1);
  assert.equal(readChoice({ choice: 'p2' }, items, 'p').ranked[0].item, 'z');
  assert.deepEqual(readChoice(undefined, items, 'p').ranked.map((r) => [r.item, r.p]), [['x', 0], ['y', 0], ['z', 0]]);
  assert.equal(readChoice({ probabilities: { p0: 'oops', p1: null } }, items, 'p').ranked[0].p, 0);
  assert.deepEqual(readChoice({ probabilities: { p9: 1 } }, items, 'p').ranked.map((r) => r.p), [0, 0, 0], 'a key that is not an option is ignored');
});

test('readYesNo is a probability from 0 to 1, or 0 when there is none', () => {
  assert.equal(readYesNo({ noul: 0.93 }), 0.93);
  assert.equal(readYesNo({ noul: 7 }), 1);
  assert.equal(readYesNo(undefined), 0);
  assert.equal(readYesNo({ noul: 'no' }), 0);
});

/* ---------- saved answers ---------- */

const answer = (over = {}) => ({ text: 'Area: 105.4 km2', title: 'Paris', part: 'Infobox', url: 'https://en.wikipedia.org/wiki/Paris', checked: 0.93, p: 0.88, ...over });

test('savedAnswer keeps the question, the quote, the source, how sure Jev was, and the steps and their cost, and nothing else', () => {
  const saved = savedAnswer({ question: 'How big is Paris?', answer: answer({ before: 'x', after: 'y', extra: 1 }), ts: 5, id: 'a1' });
  assert.deepEqual(saved, {
    id: 'a1', ts: 5, question: 'How big is Paris?', text: 'Area: 105.4 km2', refined: '', title: 'Paris', part: 'Infobox', url: 'https://en.wikipedia.org/wiki/Paris', checked: 0.93, p: 0.88,
    trail: [], stats: { requests: 0, tokens: 0, ms: 0, articles: 0, terms: [] },
  });
  const step = { id: 'term', title: 'Search term', label: 'Paris', p: 0.9, options: [{ key: 't0', label: 'Paris', p: 0.9 }], chosen: 't0', instructions: 'Which?', state: { question: 'q' } };
  const full = savedAnswer({ question: 'q', answer: answer(), trail: [step], stats: { requests: 5, tokens: 5284, ms: 4200, articles: 1, terms: ['Paris'] }, ts: 1, id: 'b' });
  assert.equal(full.trail[0].options[0].label, 'Paris');
  assert.deepEqual(full.stats, { requests: 5, tokens: 5284, ms: 4200, articles: 1, terms: ['Paris'] });
});

test('cleanTrail keeps only the known steps, as text and numbers cut to length, and never anything else', () => {
  const long = 'x'.repeat(2000);
  const trail = cleanTrail([
    { id: 'term', title: 'Search term', label: long, p: 7, note: 5, options: [{ key: 't0', label: long, p: -1 }, { nokey: true }, null], chosen: 't0', confidence: 0.4, state: { question: long, n: 1, __proto__: { x: 1 } }, extra: '<script>' },
    { id: 'evil', label: 'dropped' },
    null,
    { id: 'part', meaning: { label: 'area', p: 0.6, options: [{ key: 'area', label: 'Its land area', p: 0.6 }], confidence: 'high' }, reused: true },
    { id: 'check', p: 'nope', skipped: 'why' },
  ]);
  assert.deepEqual(trail.map((t) => t.id), ['term', 'part', 'check']);
  assert.equal(trail[0].label.length, 401);
  assert.equal(trail[0].p, 1, 'a probability is kept between 0 and 1');
  assert.equal(trail[0].note, '', 'what is not text is dropped');
  assert.deepEqual(trail[0].options.map((o) => [o.key, o.p]), [['t0', 0]]);
  assert.deepEqual(Object.keys(trail[0].state), ['question']);
  assert.equal(trail[0].state.question.length, 300);
  assert.equal(trail[0].confidence, 0.4);
  assert.equal(trail[1].meaning.options[0].label, 'Its land area');
  assert.equal(trail[1].meaning.confidence, null);
  assert.equal(trail[1].reused, true);
  assert.equal(trail[2].p, 0);
  assert.equal(trail[2].skipped, 'why');
  assert.equal(JSON.stringify(trail).includes('script'), false, 'nothing that was not a known field is carried over');
  assert.deepEqual(cleanTrail(undefined), []);
  assert.deepEqual(cleanTrail('x'), []);
  assert.equal(cleanTrail(Array.from({ length: 100 }, () => ({ id: 'term' }))).length, 60);
});

test('cleanStats keeps whole non-negative numbers and the terms searched', () => {
  assert.deepEqual(cleanStats({ requests: 5.4, tokens: -3, ms: 'slow', articles: 2, terms: ['Paris', 7, 'x'.repeat(500)] }), { requests: 5, tokens: 0, ms: 0, articles: 2, terms: ['Paris', 'x'.repeat(200)] });
  assert.deepEqual(cleanStats(undefined), { requests: 0, tokens: 0, ms: 0, articles: 0, terms: [] });
});

test('a saved answer keeps its steps when it is stored and loaded, cleaned on the way in', () => {
  const step = { id: 'article', title: 'Article', label: 'Paris', p: 0.94, options: [{ key: 'a0', label: 'Paris', p: 0.94 }, { key: 'none', label: 'None of these', p: 0.02 }], chosen: 'a0' };
  const saved = savedAnswer({ question: 'q', answer: answer(), trail: [step, { id: 'bad' }], stats: { requests: 5 }, ts: 1, id: 'a' });
  const loaded = cleanSavedAnswers(JSON.parse(JSON.stringify([saved])));
  assert.deepEqual(loaded[0].trail.map((t) => t.id), ['article']);
  assert.equal(loaded[0].trail[0].options[1].key, 'none');
  assert.equal(loaded[0].stats.requests, 5);
  const old = cleanSavedAnswers([{ id: 'o', ts: 1, question: 'q', text: 't', title: 'T', part: '', url: 'https://en.wikipedia.org/wiki/T', checked: 0.9, p: 0.9 }]);
  assert.deepEqual([old[0].trail, old[0].stats.requests], [[], 0], 'an answer saved before the steps were kept still loads');
});

test('the snippet questions can be left out of the article request', () => {
  const results = [{ title: 'Paris', snippet: 'Paris is the capital.' }, { title: 'Paris, Texas', snippet: 'A city.' }];
  const without = buildArticleRequest('q', results, { snippets: false });
  OK(without, 'article without snippets');
  assert.deepEqual(Object.keys(without.questions), ['article']);
  assert.deepEqual(Object.keys(buildArticleRequest('q', results).questions), ['article', 's0', 's1']);
});

test('addSavedAnswer puts the newest first, does not repeat an answer, and keeps the newest 50', () => {
  const one = savedAnswer({ question: 'q', answer: answer(), ts: 1, id: 'a' });
  const two = savedAnswer({ question: 'q', answer: answer({ text: 'Other' }), ts: 2, id: 'b' });
  const again = savedAnswer({ question: 'q', answer: answer(), ts: 3, id: 'c' });
  assert.deepEqual(addSavedAnswer(addSavedAnswer([], one), two).map((s) => s.id), ['b', 'a']);
  assert.deepEqual(addSavedAnswer([two, one], again).map((s) => s.id), ['c', 'b'], 'the same answer to the same question replaces the old one');
  const other = savedAnswer({ question: 'another question', answer: answer(), ts: 4, id: 'd' });
  assert.equal(addSavedAnswer([one], other).length, 2, 'the same quote for a different question is kept');
  let list = [];
  for (let i = 0; i < 60; i++) list = addSavedAnswer(list, savedAnswer({ question: `q${i}`, answer: answer(), ts: i, id: `i${i}` }));
  assert.equal(list.length, 50);
  assert.equal(list[0].id, 'i59');
});

test('cleanSavedAnswers drops what is malformed, and any answer whose link is not an address on Wikipedia', () => {
  const good = savedAnswer({ question: 'q', answer: answer(), ts: 1, id: 'a' });
  const stored = [
    good,
    null,
    'text',
    { ...good, id: 7 },
    { ...good, url: 'javascript:alert(1)' },
    { ...good, url: 'https://evil.example/wiki/Paris' },
    { ...good, url: 'https://en.wikipedia.org.evil.example/wiki/Paris' },
    { ...good, url: 'https://en.wikipedia.org/wiki/Paris x' },
    { ...good, id: 'b', part: undefined, checked: 'high', ts: NaN },
  ];
  const cleaned = cleanSavedAnswers(stored);
  assert.deepEqual(cleaned.map((s) => s.id), ['a', 'b']);
  assert.deepEqual([cleaned[1].part, cleaned[1].checked, cleaned[1].ts], ['', 0, 0]);
  assert.deepEqual(cleanSavedAnswers(undefined), []);
  assert.deepEqual(cleanSavedAnswers({}), []);
  assert.equal(cleanSavedAnswers(Array.from({ length: 80 }, (_, i) => ({ ...good, id: `x${i}` }))).length, 50);
});

test('readMeaning ranks the options of the meaning question by name', () => {
  const options = meaningOptions('How big is Paris?');
  const read = readMeaning({ probabilities: { area: 0.6, population: 0.3, both: 0.05, other: 0.05 } }, options);
  assert.deepEqual(read.map((m) => m.label), ['area', 'population', 'both', 'other']);
  assert.equal(read[0].p, 0.6);
  assert.deepEqual(readMeaning(undefined, options).map((m) => m.p), [0, 0, 0, 0]);
});

/* ---------- tables in the body of an article ---------- */

const c4Html = () => fixture('parse-c4-picasso.json').parse.text;
const c4Extract = () => fixture('extract-c4-picasso.json').query.pages[0].extract;

test('parseTables reads the body tables of a real article a row at a time, under the heading each is in', () => {
  const { tables, headings } = parseTables(c4Html());
  assert.deepEqual(tables.map((t) => t.path), ['Engines', 'Sales'], 'the wikitables only: not the table under See also, and not the navigation box');
  assert.deepEqual(headings.map((h) => h.path), ['Lead', 'First generation (2006–2013)', 'Second generation (2013–2022)', 'Second generation (2013–2022) › Transmissions', 'Engines', 'Sales', 'See also']);

  const engines = tables[0];
  assert.equal(engines.caption, 'Engine range and spec');
  assert.deepEqual(engines.headers.slice(0, 3), ['Model', 'Years', 'Engine code']);
  assert.ok(engines.headers.includes('Top speed'));
  assert.ok(engines.rows.length >= 20);
  const vti = engines.rows.find((r) => r.includes('VTi'));
  assert.equal(vti, 'Petrol engines — Model: 1.6 litre VTi 16v • Years: 2006–present • Engine code: EP6 • Displacement (cc, cu in): 1,598 (98) • Power: 89 kW; 122 PS (120 bhp) • Torque: 160 N⋅m (118 lb⋅ft) • 0–100 km/h (0–62 mph) (seconds): 12.1 • Top speed: 187 km/h (116 mph) • Transmission: five speed manual • CO2 emissions (g/km): 145');
  assert.ok(engines.rows.every((r) => r.startsWith('Petrol engines — ') || r.startsWith('Diesel engines — ') || /^[A-Za-z]+ engines — /.test(r)), 'each row carries the group it is under');
  // A cell that spans rows is carried down: the second row of the THP has the model of the first.
  const thp = engines.rows.filter((r) => r.includes('Model: 1.6 litre THP 16v'));
  assert.ok(thp.length >= 3, 'the model is repeated on each row it covers');
  assert.equal(engines.rows.some((r) => /Petrol engines — Petrol engines|Engine range and spec/.test(r)), false, 'the title and group rows are not rows');

  assert.deepEqual(tables[1].headers.slice(0, 1), ['Year']);
  assert.match(tables[1].rows[0], /^Year: 2009 • Worldwide production: 133,800/);
});

test('parseTables handles a table with no header, spans across columns, nested tables and tables to leave out', () => {
  const html = '<div class="mw-parser-output">' +
    '<table class="wikitable"><tbody><tr><td>Lead A</td><td>1</td></tr><tr><td>Lead B</td><td>2</td></tr></tbody></table>' +
    '<div class="mw-heading mw-heading2"><h2 id="Data">Data</h2></div>' +
    '<table class="wikitable sortable"><caption>Prices</caption><tbody>' +
    '<tr><th colspan="2">Name</th><th>Cost</th></tr>' +
    '<tr><td colspan="3">Group one</td></tr>' +
    '<tr><td rowspan="2">Widget</td><td>small</td><td>&#36;1<sup class="reference">[1]</sup></td></tr>' +
    '<tr><td>large</td><td>$2</td></tr>' +
    '<tr><td>Nested</td><td><table class="wikitable"><tr><td>inner</td><td>x</td></tr></table></td><td></td></tr>' +
    '</tbody></table>' +
    '<table class="infobox"><tbody><tr><th>Box</th><td>skip</td></tr></tbody></table>' +
    '<table class="wikitable"><tbody></tbody></table>' +
    '<div class="mw-heading mw-heading3"><h3 id="Deeper">Deeper</h3></div>' +
    '<table class="wikitable"><tbody><tr><th>A</th><th>B</th></tr><tr><th>All</th><th>headings</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>' +
    '<div class="mw-heading mw-heading2"><h2 id="References">References</h2></div>' +
    '<table class="wikitable"><tbody><tr><td>Ref</td><td>skip</td></tr></tbody></table></div>';
  const { tables } = parseTables(html);
  assert.deepEqual(tables.map((t) => t.path), ['Lead', 'Data', 'Data › Deeper']);
  assert.deepEqual(tables[0].rows, ['Lead A • 1', 'Lead B • 2'], 'no header: the cells are joined');
  assert.equal(tables[0].headers.length, 0);
  assert.equal(tables[1].caption, 'Prices');
  assert.deepEqual(tables[1].headers, ['Name', 'Cost']);
  // 'Name' spans two columns, so both columns are headed 'Name': the second is the same cell again and is not repeated
  assert.deepEqual(tables[1].rows.slice(0, 2), ['Group one — Name: Widget • Name: small • Cost: $1', 'Group one — Name: Widget • Name: large • Cost: $2']);
  assert.equal(tables[1].rows.length, 3, 'the nested table is one cell of a row, not more rows');
  assert.match(tables[1].rows[2], /^Group one — Name: Nested • Name: inner x/);
  assert.deepEqual(tables[2].rows, ['A: 1 • B: 2'], 'a second line of headings is not data');
  assert.deepEqual(parseTables('').tables, []);
  assert.deepEqual(parseTables(undefined).tables, []);
  assert.doesNotThrow(() => parseTables('<table class="wikitable"><tr><th>x<td>unclosed'));
});

test('mergeTables puts each table in its section, and adds the sections that are only a table where they belong', () => {
  const sections = splitSections(c4Extract()).map((s) => ({ path: s.path, anchor: s.anchor, sentences: splitSentences(s.text) }));
  assert.equal(sections.some((s) => s.path === 'Engines'), false, 'the plain text has no Engines section');
  const merged = mergeTables(sections, parseTables(c4Html()));
  const paths = merged.map((s) => s.path);
  assert.equal(paths.indexOf('Engines'), paths.indexOf('Second generation (2013–2022) › Transmissions') + 1);
  assert.equal(paths.indexOf('Sales'), paths.indexOf('Engines') + 1);
  const engines = merged.find((s) => s.path === 'Engines');
  assert.deepEqual([engines.sentences.length, engines.tables.length, engines.anchor], [0, 1, 'Engines']);
  assert.equal(merged.find((s) => s.path === 'Sales').tables.length, 1);
  assert.ok(merged.filter((s) => s.tables.length === 0).length >= 5, 'the other sections have an empty list of tables');
  assert.equal(sections.find((s) => s.path === 'Sales').tables, undefined, 'what was passed in is not changed');

  // a table in the lead, one whose heading is not known, and no tables at all
  const lead = mergeTables([{ path: 'Lead', anchor: '', sentences: ['x.'] }], { tables: [{ path: 'Lead', anchor: '', caption: '', headers: [], rows: ['a • b'] }], headings: [{ path: 'Lead', anchor: '' }] });
  assert.equal(lead[0].tables[0].rows[0], 'a • b');
  const unknown = mergeTables([{ path: 'Lead', anchor: '', sentences: ['x.'] }], { tables: [{ path: 'Mystery', anchor: 'Mystery', caption: '', headers: [], rows: ['a'] }], headings: [] });
  assert.deepEqual(unknown.map((s) => s.path), ['Mystery', 'Lead']);
  assert.deepEqual(mergeTables([{ path: 'Lead', anchor: '', sentences: ['x.'] }]).map((s) => s.tables), [[]]);
});

test('a part with a table lists its column names, as the infobox lists its row labels, and its rows are what Jev can pick from', () => {
  const sections = mergeTables(splitSections(c4Extract()).map((s) => ({ path: s.path, anchor: s.anchor, sentences: splitSentences(s.text) })), parseTables(c4Html()));
  const parts = articleParts({ title: 'Citroën C4 Picasso', infobox: [], sections });
  const engines = parts.find((p) => p.label === 'Engines');
  assert.match(engines.description, /^Engines · table: Model, Years, Engine code, .*Top speed.*, Transmission/);
  assert.ok(engines.description.length <= 400);
  const candidates = partCandidates(engines);
  assert.equal(candidates.length, engines.tableRows.length);
  const vti = candidates.find((c) => c.text.includes('VTi'));
  assert.match(vti.text, /Top speed: 187 km\/h/);
  assert.match(vti.before, /^Table columns: Model, Years/, 'the columns are the context for the check');
  assert.equal(vti.after, '');
  // a section with text and a table offers its sentences first, then its rows
  const sales = partCandidates(parts.find((p) => p.label === 'Sales'));
  assert.equal(sales.length, 1 + 6);
  assert.match(sales.at(-1).text, /^Year: 2014/);
  OK(buildPartRequest('q', 'Citroën C4 Picasso', parts), 'part request with a table');
  OK(buildAnswerRequest('q', 'Citroën C4 Picasso', 'Engines', candidates).request, 'answer request over table rows');
  // a part with no tables is described as before
  assert.equal(parts.find((p) => p.label === 'Second generation (2013–2022)').description, 'Second generation (2013–2022)');
});

/* ---------- chopping a row up ---------- */

test('rowPieces cuts a row into its pieces, without the group name, and gives none for a row of one piece', () => {
  assert.deepEqual(rowPieces('Petrol engines — Model: 1.6 litre VTi 16v • Years: 2006–present • Top speed: 187 km/h (116 mph)'), ['Model: 1.6 litre VTi 16v', 'Years: 2006–present', 'Top speed: 187 km/h (116 mph)']);
  assert.deepEqual(rowPieces('Area: 105.4 km2 (40.7 sq mi) • Urban 2,824.2 km2 (1,090.4 sq mi) • Metro 18,940.7 km2'), ['Area: 105.4 km2 (40.7 sq mi)', 'Urban 2,824.2 km2 (1,090.4 sq mi)', 'Metro 18,940.7 km2']);
  assert.deepEqual(rowPieces('Country: France'), []);
  assert.deepEqual(rowPieces('Year: 2009 — a • b'), ['Year: 2009 — a', 'b'], 'a dash inside a piece is not a group name');
  assert.deepEqual(rowPieces(''), []);
  assert.equal(rowPieces(Array.from({ length: 100 }, (_, i) => `c${i}`).join(' • ')).length, 60);
  assert.equal(rowPieces(`a • ${'x'.repeat(500)}`)[1].length, 200);
});

test('the rows of the infobox and of tables come with their pieces; a sentence does not', () => {
  const parts = articleParts(parisArticle());
  const area = partCandidates(parts[0]).find((c) => c.text.startsWith('Area: '));
  assert.deepEqual(area.pieces, ['Area: 105.4 km2 (40.7 sq mi)', 'Urban 2,824.2 km2 (1,090.4 sq mi)', 'Metro 18,940.7 km2 (7,313.0 sq mi)']);
  assert.deepEqual(partCandidates(parts[0]).find((c) => c.text === 'Country: France').pieces, []);
  assert.equal(partCandidates(parts[1])[0].pieces, undefined, 'a sentence of prose');
  const sections = mergeTables(splitSections(c4Extract()).map((s) => ({ path: s.path, anchor: s.anchor, sentences: splitSentences(s.text) })), parseTables(c4Html()));
  const engines = partCandidates(articleParts({ title: 'x', infobox: [], sections }).find((p) => p.label === 'Engines'));
  const vti = engines.find((c) => c.text.includes('VTi'));
  assert.equal(vti.pieces.length, 10);
  assert.ok(vti.pieces.includes('Top speed: 187 km/h (116 mph)'));
});

test('the refine request offers the pieces of the row, with a way out, and maps back to them', () => {
  const candidate = { text: 'Petrol engines — Model: VTi • Top speed: 187 km/h', pieces: ['Model: VTi', 'Top speed: 187 km/h'] };
  const { request, pieces } = buildRefineRequest('top speed of the VTi?', 'Citroën C4 Picasso', 'Engines', candidate);
  OK(request, 'refine');
  assert.deepEqual(pieces, candidate.pieces);
  assert.deepEqual(Object.keys(request.questions.refine.criteria), ['r0', 'r1', 'none']);
  assert.equal(request.questions.refine.criteria.r1, 'Top speed: 187 km/h');
  assert.deepEqual(request.state, { question: 'top speed of the VTi?', article: 'Citroën C4 Picasso', part: 'Engines', row: candidate.text });
  assert.equal(readChoice({ probabilities: { r0: 0.1, r1: 0.85, none: 0.05 } }, pieces, 'r').ranked[0].item, 'Top speed: 187 km/h');
});

test('the final check asks that every detail of the question matches', () => {
  const check = buildCheckRequest('q', 'Paris', 'Infobox', { text: 'S', before: '', after: '' });
  assert.match(check.questions.answers.instructions, /exactly what the question specifies/);
});

test('a saved answer keeps the refined piece, and the refine step is a known kind of step', () => {
  const saved = savedAnswer({ question: 'q', answer: answer({ refined: 'Top speed: 187 km/h' }), trail: [{ id: 'refine', title: 'Refine', label: 'Top speed: 187 km/h', p: 0.9 }], ts: 1, id: 'a' });
  assert.equal(saved.refined, 'Top speed: 187 km/h');
  assert.deepEqual(saved.trail.map((t) => t.id), ['refine']);
  const [loaded] = cleanSavedAnswers(JSON.parse(JSON.stringify([saved])));
  assert.equal(loaded.refined, 'Top speed: 187 km/h');
  assert.equal(cleanSavedAnswers([{ ...saved, refined: 5 }])[0].refined, '');
  assert.equal(cleanSavedAnswers([{ ...saved, refined: 'x'.repeat(900) }])[0].refined.length, 500);
});
