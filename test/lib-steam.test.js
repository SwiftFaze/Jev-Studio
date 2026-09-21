import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_MAX_CHARS, STEAM_GROUP_SIZES, GROUP_REVIEW_MAX_CHARS, groupClipChars, groupPlan, groupRequests, groupTokensEstimate, SHARE_BANDS, buildGroupState, chunkReviews, clipForGroup, groupTallyRows, mergeGroupTallies, questionSignature, savedGroupTally, savedGroupTotal, shareFromAnswer, steamGroupQuestions, summarizeGroupTally, tokensPerReviewEstimate, STEAM_QUESTION_IDS, emptyGroupTally, describeSteamReview, savedTotal, steamFilter, steamFilterChoices, pickLabel, fieldsFromSaved, rowHasAnswer, savedTally, snapshotOf, moreSlider, reviewsFor, roughDuration, roughTokens, batchReplyProblem, buildSteamState, cleanReviewText, emptyTally, expectedFor, MAX_REVIEW_CHARS, mergeTallies, MIN_MENTIONS, NOT_MENTIONED, parseSteamApp, steamQuestions, steamSpecs, STEAM_BATCH_SIZES, STEAM_GROUPS, STEAM_MAX_BATCH, STEAM_PLATFORM, STEAM_TOPICS, storeUrl, summarizeSteam, summarizeTally, tallyRows, thumbsUpShare, toneFor, visibleGroups } from '../public/lib/steam.js';
import { batchCsvRows } from '../public/lib/export.js';
import { verdictFor } from '../public/lib/accuracy.js';
import { parseCsv, toCsv } from '../public/lib/csv.js';
import { validateRequest } from '../src/validate.js';
import { mockResponse } from '../src/mock.js';

/* ---------- reading a link ---------- */

test('the store link from the request gives the app id and the name in its slug', () => {
  assert.deepEqual(parseSteamApp('https://store.steampowered.com/app/548430/Deep_Rock_Galactic/'), { appId: '548430', name: 'Deep Rock Galactic' });
});

test('the reviews API link, a link with no slug, a bare id, and surrounding spaces all work; only the link with a slug has a name', () => {
  assert.deepEqual(parseSteamApp('https://store.steampowered.com/appreviews/548430'), { appId: '548430', name: null });
  assert.deepEqual(parseSteamApp('https://store.steampowered.com/app/548430'), { appId: '548430', name: null });
  assert.deepEqual(parseSteamApp('https://store.steampowered.com/app/548430/'), { appId: '548430', name: null });
  assert.deepEqual(parseSteamApp('548430'), { appId: '548430', name: null });
  assert.deepEqual(parseSteamApp('  https://store.steampowered.com/app/548430/Deep_Rock_Galactic/  \n'), { appId: '548430', name: 'Deep Rock Galactic' });
});

test('links without a scheme, with www, http, a query or a fragment, and community links are accepted', () => {
  for (const link of [
    'store.steampowered.com/app/548430/Deep_Rock_Galactic',
    'http://store.steampowered.com/app/548430/Deep_Rock_Galactic/',
    'https://STORE.STEAMPOWERED.COM/app/548430/Deep_Rock_Galactic/?curator_clanid=1#app_reviews_hash',
    'https://steamcommunity.com/app/548430',
    'https://www.steamcommunity.com/app/548430/reviews/',
  ]) {
    assert.equal(parseSteamApp(link)?.appId, '548430', link);
  }
});

test('an app id has its leading zeros dropped, and zero is not an app', () => {
  assert.equal(parseSteamApp('000548430').appId, '548430');
  assert.equal(parseSteamApp('0'), null);
  assert.equal(parseSteamApp('000'), null);
});

test('a percent-encoded slug is decoded, and a broken one is kept as it is rather than failing', () => {
  assert.equal(parseSteamApp('https://store.steampowered.com/app/553850/HELLDIVERS%E2%84%A2_2/').name, 'HELLDIVERS™ 2');
  assert.equal(parseSteamApp('https://store.steampowered.com/app/553850/Bad%E0%A4%A_Name/').name, 'Bad%E0%A4%A Name');
});

test('anything that is not a Steam app is refused, including look-alike hosts', () => {
  for (const notSteam of [
    '',
    '   ',
    null,
    undefined,
    'Deep Rock Galactic',
    'https://store.steampowered.com/',
    'https://store.steampowered.com/app/abc/',
    'https://store.steampowered.com/app/',
    'https://store.steampowered.com/news/app/548430',
    'https://example.com/app/548430/Deep_Rock_Galactic/',
    'https://store.steampowered.com.evil.example/app/548430/x',
    'https://evil.example/?next=store.steampowered.com/app/548430',
    'https://user@evil.example/app/548430',
    'ftp://store.steampowered.com/app/548430',
    'javascript:alert(1)',
    '12345678901',
    '-5',
    '54.8',
  ]) {
    assert.equal(parseSteamApp(notSteam), null, String(notSteam));
  }
});

test('storeUrl builds the store page from the id alone', () => {
  assert.equal(storeUrl('548430'), 'https://store.steampowered.com/app/548430/');
});

/* ---------- cleaning a review ---------- */

test("Steam's markup is removed but the words stay", () => {
  assert.equal(cleanReviewText('[h1]Great[/h1]\n\n[b]game[/b] and [i]fun[/i]'), 'Great game and fun');
  assert.equal(cleanReviewText('see [url=https://example.test/x]my guide[/url] for more'), 'see my guide for more');
  assert.equal(cleanReviewText('[list][*]co-op[*]loot[/list]'), 'co-op loot');
  assert.equal(cleanReviewText('[spoiler]the ending is weak[/spoiler]'), 'the ending is weak', 'a spoiler tag hides words that may be the opinion');
});

test('pictures and videos are dropped with what is inside them', () => {
  assert.equal(cleanReviewText('before [img]https://cdn.example/a.png[/img] after'), 'before after');
  assert.equal(cleanReviewText('[previewyoutube=abc123;full][/previewyoutube]fun'), 'fun');
});

test('text that only looks like markup is left alone', () => {
  assert.equal(cleanReviewText('I give it [10/10] and [sic] stays'), 'I give it [10/10] and [sic] stays');
});

test('whitespace collapses to single spaces, so a review is one line', () => {
  assert.equal(cleanReviewText('  line one\r\n\r\n\tline   two  '), 'line one line two');
});

test('a review with nothing to read comes out empty, and null or undefined do not throw', () => {
  assert.equal(cleanReviewText('[b][/b] [img]x[/img]'), '');
  assert.equal(cleanReviewText(null), '');
  assert.equal(cleanReviewText(undefined), '');
});

test('a long review is cut at the limit, ending in an ellipsis, and a short one is untouched', () => {
  const long = cleanReviewText('word '.repeat(2000));
  assert.ok(long.length <= MAX_REVIEW_CHARS);
  assert.ok(long.endsWith('…'));
  assert.equal(cleanReviewText('short'), 'short');
  assert.equal(cleanReviewText('abcdefghij', 5), 'abcd…');
});

/* ---------- the questions ---------- */

test('the fixed questions are valid requests, and every topic has a question of the same type, plus the platform question', () => {
  const questions = steamQuestions();
  assert.equal(validateRequest({ state: 'x', questions }).ok, true);
  assert.deepEqual(Object.keys(questions), [...STEAM_TOPICS.map((t) => t.id), STEAM_PLATFORM.id], 'the topics, in order, then the platform question that is crossed with performance');
  for (const topic of STEAM_TOPICS) assert.equal(questions[topic.id].type, topic.type, topic.id);
  assert.equal(questions[STEAM_PLATFORM.id].type, 'choice');
});

test('every topic has well-formed options: unique keys, a tone each, a good side and a bad side, and a not-mentioned option where a review can say nothing', () => {
  const questions = steamQuestions();
  for (const topic of STEAM_TOPICS) {
    const keys = topic.options.map((o) => o.key);
    assert.equal(new Set(keys).size, keys.length, `${topic.id}: option keys are unique`);
    assert.ok(!keys.includes(NOT_MENTIONED), `${topic.id}: not_mentioned is added for it, not listed`);
    for (const o of topic.options) {
      assert.ok(['good', 'bad', 'neutral'].includes(o.tone), `${topic.id}/${o.key}`);
      assert.ok(o.label.trim() && o.note.trim(), `${topic.id}/${o.key} has a label and a description`);
    }
    assert.ok(topic.options.some((o) => o.tone === 'good') && topic.options.some((o) => o.tone === 'bad'), `${topic.id} has a side for and a side against`);
    assert.ok(topic.options.some((o) => o.tone === topic.headline), `${topic.id}: the headline side exists`);
    assert.ok(STEAM_GROUPS.some((g) => g.id === topic.group), `${topic.id} is in a known group`);
    assert.ok(topic.question.trim() && topic.label.trim() && topic.says.trim(), topic.id);

    const criteria = questions[topic.id].criteria;
    if (topic.type === 'noul') {
      assert.deepEqual(Object.keys(criteria), ['true', 'false']);
    } else {
      assert.deepEqual(Object.keys(criteria), [...keys, NOT_MENTIONED], `${topic.id}: the question offers the options, then not mentioned`);
      assert.ok(criteria[NOT_MENTIONED].trim(), topic.id);
    }
  }
  const platformKeys = Object.keys(questions[STEAM_PLATFORM.id].criteria);
  assert.deepEqual(platformKeys, [...STEAM_PLATFORM.options.map((o) => o.key), NOT_MENTIONED]);
});

test('the default composite counts overall positivity only, and every Choice target is one of its options', () => {
  const specs = steamSpecs();
  const questions = steamQuestions();
  assert.deepEqual(Object.keys(specs), Object.keys(questions));
  assert.deepEqual(Object.entries(specs).filter(([, s]) => s.enabled).map(([id]) => id), ['positive']);
  for (const [id, spec] of Object.entries(specs)) {
    if (questions[id].type === 'choice') assert.ok(spec.target in questions[id].criteria, id);
  }
});

/* ---------- what Jev reads about a review ---------- */

const fullMeta = () => ({ votedUp: true, hoursTotal: 1240.3, hoursAtReview: 80, hoursRecent: 12.5, votesUp: 34, refunded: true, freeCopy: true, earlyAccess: true, steamDeck: true });

test('what Jev reads is a short formatted block: who is writing, what could colour the review, then the review', () => {
  const state = buildSteamState('Deep Rock Galactic', { text: '  Great co-op, runs fine.  ', meta: fullMeta() });
  assert.equal(
    state,
    [
      'Steam review of Deep Rock Galactic.',
      '',
      'About the reviewer:',
      '- Playtime: 1,240 hours in total; 80 hours by the time they wrote the review; 12.5 hours in the last two weeks.',
      '- Received the game for free.',
      '- Refunded the game.',
      '- Wrote the review during Early Access.',
      '- Plays mostly on a Steam Deck.',
      '- 34 people found the review helpful.',
      '',
      'Review:',
      'Great co-op, runs fine.',
    ].join('\n'),
  );
});

test('the reviewer\'s thumbs are left out unless asked for, because they are the answer key for the positive question', () => {
  const row = { text: 'Great.', meta: fullMeta() };
  assert.doesNotMatch(buildSteamState('X', row), /verdict|recommend|thumb|voted/i);
  assert.doesNotMatch(buildSteamState('X', row, { thumbs: false }), /verdict|recommend/i);
  assert.match(buildSteamState('X', row, { thumbs: true }), /Their verdict on Steam: recommended\./);
  assert.match(buildSteamState('X', { text: 'Bad.', meta: { ...fullMeta(), votedUp: false } }, { thumbs: true }), /not recommended/);
});

test('a line with nothing to say is left out, so an ordinary review stays short', () => {
  const state = buildSteamState('X', { text: 'Fun.', meta: { votedUp: true, hoursTotal: 2, hoursAtReview: 2, hoursRecent: 0, votesUp: 0, refunded: false, freeCopy: false, earlyAccess: false, steamDeck: false } });
  assert.equal(state, 'Steam review of X.\n\nAbout the reviewer:\n- Playtime: 2 hours in total; 2 hours by the time they wrote the review; none in the last two weeks.\n\nReview:\nFun.');
  assert.doesNotMatch(state, /free|refund|Early Access|Deck|helpful/);
});

test('playtime Steam did not report is left out, which is not the same as none', () => {
  const state = buildSteamState('X', { text: 'Fun.', meta: { hoursTotal: 10, hoursAtReview: null, hoursRecent: null } });
  assert.match(state, /- Playtime: 10 hours in total\./);
  assert.doesNotMatch(state, /by the time|last two weeks/);
});

test('hours read as people say them, and one of anything is singular', () => {
  const line = (meta) => buildSteamState('X', { text: 't', meta }).split('\n').find((l) => l.startsWith('- '));
  assert.equal(line({ hoursTotal: 1 }), '- Playtime: 1 hour in total.');
  assert.equal(line({ hoursTotal: 0.4 }), '- Playtime: 0.4 hours in total.');
  assert.equal(line({ hoursTotal: 1234.6 }), '- Playtime: 1,235 hours in total.');
  assert.equal(line({ votesUp: 1 }), '- 1 person found the review helpful.');
});

test('with no facts about the reviewer it is just the review under the game\'s name, as before', () => {
  assert.equal(buildSteamState('Deep Rock Galactic', { text: '  Loved it.  ' }), 'Steam review of Deep Rock Galactic:\n\nLoved it.');
  assert.equal(buildSteamState(null, { text: 'Loved it.' }), 'Steam review of a game:\n\nLoved it.');
  assert.equal(buildSteamState('   ', { text: 'Loved it.' }), 'Steam review of a game:\n\nLoved it.');
});

test('what Jev reads never holds Steam\'s raw data: no JSON, and no name, profile or id of the reviewer', () => {
  const state = buildSteamState('X', { text: 'Fun.', meta: { ...fullMeta(), steamid: '76561198000000000', personaname: 'Someone Real', weighted_vote_score: '0.93' } });
  assert.doesNotMatch(state, /[{}"]|steamid|personaname|76561198|Someone Real|weighted/);
});

test("Steam's thumbs become the expected answer for the positive question, and the accuracy check reads it", () => {
  assert.deepEqual(expectedFor({ votedUp: true }), { positive: 'yes' });
  assert.deepEqual(expectedFor({ votedUp: false }), { positive: 'no' });

  const questions = steamQuestions();
  const agree = { index: 0, status: 'ok', expected: expectedFor({ votedUp: true }), response: { answers: { positive: { type: 'noul', noul: 0.9 } } } };
  const disagree = { ...agree, expected: expectedFor({ votedUp: false }) };
  assert.equal(verdictFor(agree, questions.positive, 'positive'), true);
  assert.equal(verdictFor(disagree, questions.positive, 'positive'), false);
  assert.equal(verdictFor(agree, questions.worth_price, 'worth_price'), null, 'no expected answer for the other questions, so they are not scored');
});

/* ---------- rolling the answers up ---------- */

const noul = (p) => ({ type: 'noul', noul: p });
const choice = (key) => ({ type: 'choice', choice: key, confidence: 0.9, probabilities: { [key]: 0.9 } });
const answered = (index, answers) => ({ index, text: `Review ${index}`, status: 'ok', expected: {}, response: { answers } });

test('each topic counts for and against among the reviews that mention it, and leaves the rest out', () => {
  const run = {
    questions: steamQuestions(),
    rows: [
      answered(0, { positive: noul(0.9), worth_price: choice('worth_it'), performance: choice('runs_badly') }),
      answered(1, { positive: noul(0.7), worth_price: choice('worth_it'), performance: choice('not_mentioned') }),
      answered(2, { positive: noul(0.5), worth_price: choice('not_worth_it'), performance: choice('not_mentioned') }),
      answered(3, { positive: noul(0.1), worth_price: choice('not_mentioned'), performance: choice('runs_badly') }),
      { index: 4, text: 'failed', status: 'error', error: 'boom' },
      { index: 5, text: 'waiting', status: 'pending' },
    ],
  };
  const sum = summarizeSteam(run);
  const topic = (id) => sum.topics.find((t) => t.id === id);

  assert.equal(sum.total, 6);
  assert.equal(sum.answered, 4, 'failed and pending rows are not counted');

  // positive is asked of every review; 0.5 counts as yes, as it does everywhere else
  assert.deepEqual([topic('positive').good, topic('positive').bad, topic('positive').mentioned], [3, 1, 4]);
  assert.equal(topic('positive').goodShare, 0.75);

  // worth_price: 2 worth it, 1 not, 1 not mentioned -> 2 of the 3 mentions are for it, mentioned in 3 of 4
  assert.deepEqual([topic('worth_price').good, topic('worth_price').bad, topic('worth_price').mentioned], [2, 1, 3]);
  assert.equal(topic('worth_price').goodShare, 2 / 3);
  assert.equal(topic('worth_price').mentionShare, 3 / 4);

  assert.deepEqual([topic('performance').good, topic('performance').bad], [0, 2]);
  assert.equal(topic('performance').goodShare, 0);
});

test('a topic nobody mentions has no share (not 0%), and a topic with only a few mentions is marked as too few', () => {
  const rows = Array.from({ length: MIN_MENTIONS - 1 }, (_, i) => answered(i, { positive: noul(0.9), pay_to_win: choice(i === 0 ? 'says_pay_to_win' : 'not_mentioned') }));
  const sum = summarizeSteam({ questions: steamQuestions(), rows });
  const p2w = sum.topics.find((t) => t.id === 'pay_to_win');
  assert.equal(p2w.mentioned, 1);
  assert.equal(p2w.tooFew, true);
  assert.equal(p2w.goodShare, 0);

  const nobody = sum.topics.find((t) => t.id === 'stability');
  assert.equal(nobody.answered, 0, 'the run has no answers for it at all');
  assert.equal(nobody.goodShare, null);
  assert.equal(nobody.mentionShare, null);
});

test('enough mentions is not "too few"', () => {
  const rows = Array.from({ length: MIN_MENTIONS }, (_, i) => answered(i, { performance: choice(i % 2 ? 'runs_well' : 'runs_badly') }));
  const perf = summarizeSteam({ questions: steamQuestions(), rows }).topics.find((t) => t.id === 'performance');
  assert.equal(perf.mentioned, MIN_MENTIONS);
  assert.equal(perf.tooFew, false);
});

test('an answer that is missing from a response is skipped instead of counted as anything', () => {
  const sum = summarizeSteam({ questions: steamQuestions(), rows: [answered(0, { positive: noul(0.9) })] });
  assert.equal(sum.topics.find((t) => t.id === 'worth_price').answered, 0);
  assert.equal(sum.topics.find((t) => t.id === 'positive').answered, 1);
});

test('the roll-up works on real response shapes (the mock), and every topic accounts for every answered review', () => {
  const questions = steamQuestions();
  const rows = Array.from({ length: 40 }, (_, i) => ({ index: i, text: `review ${i}`, status: 'ok', expected: {}, response: mockResponse({ state: buildSteamState('X', { text: `review ${i}` }), questions }) }));
  const sum = summarizeSteam({ questions, rows });
  assert.equal(sum.answered, 40);
  for (const t of sum.topics) {
    assert.equal(t.answered, 40, t.id);
    assert.equal(t.good + t.bad + t.neutral, t.mentioned, t.id);
    assert.ok(t.mentioned <= t.answered, t.id);
    const counted = t.options.reduce((sum, o) => sum + o.n, 0) + (tallyRows(rows).topics[t.id].options[NOT_MENTIONED] ?? 0);
    assert.equal(counted, t.answered, `${t.id}: every answer landed in exactly one option`);
  }
});

test('the share of thumbs up in a sample, and nothing for an empty one', () => {
  assert.equal(thumbsUpShare([{ votedUp: true }, { votedUp: true }, { votedUp: false }, { votedUp: true }]), 0.75);
  assert.equal(thumbsUpShare([]), null);
});

/* ---------- exporting ---------- */

test('a Steam run exports a review column and the thumbs, hours and helpful votes, and survives a CSV round trip', () => {
  const questions = steamQuestions();
  const run = {
    kind: 'steam',
    questions,
    specs: steamSpecs(),
    marks: {},
    settings: { minCertainty: 0.5, compositeOn: false },
    rows: [
      { index: 0, text: '=HYPERLINK("http://x","y") great, "fun" game', status: 'ok', expected: { positive: 'yes' }, meta: { votedUp: true, hoursTotal: 812.5, hoursAtReview: 12.5, hoursRecent: 3, votesUp: 3, refunded: false, freeCopy: true }, response: mockResponse({ state: 'a', questions }) },
      { index: 1, text: 'Bad', status: 'ok', expected: { positive: 'no' }, meta: { votedUp: false, hoursTotal: 0.2, hoursAtReview: 0.2, hoursRecent: 0, votesUp: 0, refunded: true, freeCopy: false }, response: mockResponse({ state: 'b', questions }) },
    ],
  };
  const table = batchCsvRows(run);
  assert.deepEqual(table[0].slice(0, 9), ['#', 'review', 'steam_thumbs_up', 'hours_total', 'hours_at_review', 'hours_last_two_weeks', 'votes_helpful', 'refunded', 'free_copy']);
  assert.deepEqual(table[1].slice(0, 9), [1, '=HYPERLINK("http://x","y") great, "fun" game', 'yes', 812.5, 12.5, 3, 3, 'no', 'yes']);
  assert.deepEqual(table[2].slice(2, 9), ['no', 0.2, 0.2, 0, 0, 'yes', 'no']);
  assert.ok(table[0].includes('positive_correct'), 'the thumbs are scored as expected answers');

  // reviews are untrusted text from the internet: one that starts like a formula must not run when the file is opened
  const parsed = parseCsv(toCsv(table));
  assert.equal(parsed[1][1], `'=HYPERLINK("http://x","y") great, "fun" game`);
  assert.equal(parsed.length, 3);
});

/* ---------- the summary cards: which way a number reads, its colour, and when it is only a dash ---------- */

const topicOf = (rows, id) => summarizeSteam({ questions: steamQuestions(), rows }).topics.find((t) => t.id === id);
/** `counts` is how many reviews chose each option of one Choice question. */
const choiceRows = (id, counts) =>
  Object.entries(counts).flatMap(([option, n]) => Array.from({ length: n }, () => ({ answers: { [id]: choice(option) } }))).map((r, i) => answered(i, r.answers));

test('pay to win: nobody says it is, so the card reads 0% in green, not 100%', () => {
  const p2w = topicOf(choiceRows('pay_to_win', { says_not_pay_to_win: 15, says_pay_to_win: 0, not_mentioned: 5 }), 'pay_to_win');
  assert.equal(p2w.label, 'Pay to win');
  assert.equal(p2w.share, 0, 'the big number is the share who say it IS pay to win, which is what the title says');
  assert.equal(p2w.goodShare, 1, 'and the share for the game is the other way round');
  assert.equal(p2w.tone, 'good', 'so a low pay-to-win is green');
  assert.deepEqual([p2w.good, p2w.bad, p2w.mentioned, p2w.answered], [15, 0, 15, 20]);
});

test('the same topic with many saying it is pay to win reads high and red', () => {
  const p2w = topicOf(choiceRows('pay_to_win', { says_not_pay_to_win: 2, says_pay_to_win: 18 }), 'pay_to_win');
  assert.equal(p2w.share, 0.9);
  assert.equal(p2w.tone, 'bad');
});

test('every topic says which side its big number counts, and with all-good answers every card is green whichever side that is', () => {
  for (const topic of STEAM_TOPICS) {
    assert.ok(topic.headline === 'good' || topic.headline === 'bad', topic.id);
    assert.ok(topic.says.trim(), `${topic.id} has a phrase for what the number counts`);
  }
  // all-good answers: a "good" headline is 100% and a "bad" headline is 0%, and both are green
  const rows = Array.from({ length: MIN_MENTIONS }, (_, i) => answered(i, Object.fromEntries(STEAM_TOPICS.map((t) => [t.id, t.type === 'noul' ? noul(0.9) : choice(t.options.find((o) => o.tone === 'good').key)]))));
  for (const t of summarizeSteam({ questions: steamQuestions(), rows }).topics) {
    assert.equal(t.share, t.headline === 'good' ? 1 : 0, t.id);
    assert.equal(t.tone, 'good', t.id);
  }
});

test('the tone follows the share for the game: good from two thirds, mixed to two fifths, bad below, none with no data', () => {
  assert.equal(toneFor(1), 'good');
  assert.equal(toneFor(2 / 3), 'good');
  assert.equal(toneFor(0.66), 'mixed');
  assert.equal(toneFor(0.4), 'mixed');
  assert.equal(toneFor(0.39), 'bad');
  assert.equal(toneFor(0), 'bad');
  assert.equal(toneFor(null), 'none');
});

test('with fewer than the minimum mentions there is no tone, so the page shows a dash and never a lone 100%', () => {
  const few = topicOf(choiceRows('pay_to_win', { says_not_pay_to_win: MIN_MENTIONS - 1, not_mentioned: 30 }), 'pay_to_win');
  assert.equal(few.tooFew, true);
  assert.equal(few.tone, 'none');
  assert.equal(few.goodShare, 1, 'the maths still says 100%, which is exactly why it is not shown');

  const enough = topicOf(choiceRows('pay_to_win', { says_not_pay_to_win: MIN_MENTIONS }), 'pay_to_win');
  assert.equal(enough.tooFew, false);
  assert.equal(enough.tone, 'good');

  // the start of a run: a few answered reviews must not flash "100% positive"
  const start = topicOf(Array.from({ length: 3 }, (_, i) => answered(i, { positive: noul(0.9) })), 'positive');
  assert.equal(start.tooFew, true);
  assert.equal(start.tone, 'none');
});

test('the minimum for a percentage is at least 10 mentions', () => {
  assert.ok(MIN_MENTIONS >= 10);
});

/* ---------- reading in batches: counts that add up ---------- */

const okRow = (index, answers, tokens = 100) => ({ index, text: `r${index}`, status: 'ok', expected: {}, response: { answers, usage: { input_tokens: tokens - 10, output_tokens: 10 } } });
const sampleRows = () => [
  okRow(0, { positive: noul(0.9), worth_price: choice('worth_it'), pay_to_win: choice('says_not_pay_to_win'), performance: choice('runs_badly') }),
  okRow(1, { positive: noul(0.2), worth_price: choice('not_worth_it'), pay_to_win: choice('not_mentioned'), performance: choice('runs_badly') }),
  okRow(2, { positive: noul(0.5), worth_price: choice('worth_it'), pay_to_win: choice('says_pay_to_win'), performance: choice('runs_well') }),
  { index: 3, text: 'failed', status: 'error', error: 'boom' },
  { index: 4, text: 'waiting', status: 'pending' },
  okRow(5, { positive: noul(0.7) }),
];

test('an empty tally has a counter for every option of every topic, and for every platform, all at zero', () => {
  const tally = emptyTally();
  assert.deepEqual(Object.keys(tally.topics), STEAM_TOPICS.map((t) => t.id));
  assert.deepEqual([tally.answered, tally.failed, tally.tokens], [0, 0, 0]);
  for (const t of STEAM_TOPICS) {
    const expected = [...t.options.map((o) => o.key), ...(t.type === 'choice' ? [NOT_MENTIONED] : [])];
    assert.deepEqual(Object.keys(tally.topics[t.id].options), expected, t.id);
    assert.deepEqual(Object.values(tally.topics[t.id].options).filter(Boolean), [], t.id);
    assert.equal(tally.topics[t.id].answered, 0);
  }
  assert.deepEqual(Object.keys(tally.platforms), STEAM_PLATFORM.options.map((o) => o.key));
  for (const counts of Object.values(tally.platforms)) assert.deepEqual(counts, { good: 0, bad: 0 });
  assert.notEqual(emptyTally().topics, emptyTally().topics, 'each call gives its own counters, so one cannot change another');
});

test('tallyRows counts answered and failed rows, the tokens used, and how each topic\'s answers fell', () => {
  const tally = tallyRows(sampleRows());
  assert.deepEqual([tally.answered, tally.failed, tally.tokens], [4, 1, 400], 'the pending row is neither answered nor failed');
  assert.deepEqual(tally.topics.positive, { answered: 4, options: { yes: 3, no: 1 } }, '0.5 counts as yes, as everywhere else');
  assert.deepEqual(tally.topics.worth_price, { answered: 3, options: { worth_it: 2, not_worth_it: 1, not_mentioned: 0 } });
  assert.deepEqual(tally.topics.pay_to_win, { answered: 3, options: { says_not_pay_to_win: 1, says_pay_to_win: 1, not_mentioned: 1 } }, 'not mentioned is answered, and counted as its own option');
  assert.deepEqual(tally.topics.performance, { answered: 3, options: { runs_well: 1, runs_badly: 2, not_mentioned: 0 } });
  assert.deepEqual(tally.topics.stability, { answered: 0, options: { stable: 0, buggy: 0, not_mentioned: 0 } });
});

test('tallying batches separately and adding them up is the same as tallying every row at once', () => {
  const all = [...sampleRows(), ...sampleRows().map((r) => ({ ...r, index: r.index + 10 })), ...sampleRows().slice(0, 3)];
  const together = tallyRows(all);
  const inBatches = [all.slice(0, 6), all.slice(6, 12), all.slice(12)].map(tallyRows).reduce(mergeTallies, emptyTally());
  assert.deepEqual(inBatches, together);
});

test('mergeTallies changes neither tally, treats a missing one as nothing, and copes with an older shape', () => {
  const a = tallyRows(sampleRows());
  const before = JSON.stringify(a);
  const merged = mergeTallies(a, a);
  assert.equal(JSON.stringify(a), before);
  assert.equal(merged.answered, a.answered * 2);
  assert.deepEqual(mergeTallies(a, null), a);
  assert.deepEqual(mergeTallies(emptyTally(), undefined), emptyTally());
  assert.deepEqual(mergeTallies(emptyTally(), { answered: 2 }).answered, 2, 'a saved tally with fields missing does not throw');
});

test('a tally survives being saved and read back, which is how the totals are kept between visits', () => {
  const tally = tallyRows(sampleRows());
  assert.deepEqual(mergeTallies(emptyTally(), JSON.parse(JSON.stringify(tally))), tally);
});

test('the summary of a tally reads the same as the summary of the rows it came from', () => {
  const rows = Array.from({ length: 30 }, (_, i) => okRow(i, { positive: noul(i % 3 ? 0.9 : 0.1), worth_price: choice(i % 2 ? 'worth_it' : 'not_worth_it'), pay_to_win: choice('not_mentioned'), performance: choice('runs_badly'), stability: choice('stable'), replayability: choice('lots_to_do') }));
  const fromRows = summarizeSteam({ questions: steamQuestions(), rows });
  const fromTally = summarizeTally(tallyRows(rows));
  assert.equal(fromRows.total, 30);
  assert.deepEqual({ ...fromRows, total: undefined }, { ...fromTally, total: undefined });
  const pay = fromTally.topics.find((t) => t.id === 'pay_to_win');
  assert.equal(pay.tone, 'none', 'nobody mentions it, so there is nothing to show but a dash');
});

test('a summary over several batches turns from a dash into a percentage once enough have mentioned the topic', () => {
  const batch = (n) => Array.from({ length: n }, (_, i) => okRow(i, { positive: noul(0.9), performance: choice('runs_badly') }));
  const perBatch = Math.ceil(MIN_MENTIONS / 2) - 1; // one batch alone is too few, two together are enough
  const one = summarizeTally(tallyRows(batch(perBatch))).topics.find((t) => t.id === 'performance');
  assert.equal(one.tooFew, true);
  const two = summarizeTally(mergeTallies(tallyRows(batch(perBatch)), tallyRows(batch(perBatch)))).topics.find((t) => t.id === 'performance');
  assert.equal(two.tooFew, perBatch * 2 < MIN_MENTIONS);
  const three = summarizeTally(mergeTallies(mergeTallies(tallyRows(batch(perBatch)), tallyRows(batch(perBatch))), tallyRows(batch(perBatch)))).topics.find((t) => t.id === 'performance');
  assert.equal(three.tooFew, false);
  assert.equal(three.share, 1);
  assert.equal(three.tone, 'bad');
});

/* ---------- batch sizes ---------- */

test('batch sizes are whole numbers, ascending, and none is more than one request to the server allows', () => {
  assert.ok(STEAM_BATCH_SIZES.length >= 3);
  assert.deepEqual([...STEAM_BATCH_SIZES], [...STEAM_BATCH_SIZES].sort((a, b) => a - b));
  for (const n of STEAM_BATCH_SIZES) assert.ok(Number.isInteger(n) && n >= 1 && n <= STEAM_MAX_BATCH, String(n));
  assert.equal(STEAM_BATCH_SIZES.at(-1), STEAM_MAX_BATCH, 'the biggest choice is the biggest allowed');
});

/* ---------- the wider set of topics ---------- */

const rowsOf = (id, counts, extra = {}) => Object.entries(counts).flatMap(([option, n]) => Array.from({ length: n }, () => ({ [id]: choice(option), ...extra }))).map((answers, i) => answered(i, answers));

test('every point on the list is asked about, each under a heading, and every heading has topics', () => {
  const ids = STEAM_TOPICS.map((t) => t.id);
  for (const wanted of ['difficulty', 'learning_curve', 'multiplayer', 'friends', 'ai_quality', 'controls_ui', 'story', 'monetization', 'microtransactions', 'ai_slop', 'length', 'save_issues', 'netcode', 'dev_responsiveness', 'community', 'customer_support', 'comparison']) {
    assert.ok(ids.includes(wanted), wanted);
  }
  assert.ok(steamQuestions()[STEAM_PLATFORM.id], 'performance by platform is asked through the platform question');
  for (const group of STEAM_GROUPS) assert.ok(STEAM_TOPICS.some((t) => t.group === group.id), `${group.id} has topics`);
  assert.equal(new Set(ids).size, ids.length);
});

test('a topic with two bad sides counts each, and the big number is the share who say it is balanced', () => {
  const difficulty = topicOf(rowsOf('difficulty', { well_balanced: 6, too_hard: 4, too_easy: 2, not_mentioned: 8 }), 'difficulty');
  assert.deepEqual(difficulty.options.map((o) => [o.key, o.n]), [['well_balanced', 6], ['too_easy', 2], ['too_hard', 4]]);
  assert.deepEqual([difficulty.good, difficulty.bad, difficulty.mentioned, difficulty.answered], [6, 6, 12, 20]);
  assert.equal(difficulty.share, 0.5);
  assert.equal(difficulty.tone, 'mixed');

  const length = topicOf(rowsOf('length', { just_right: 3, too_short: 5, padded: 4 }), 'length');
  assert.equal(length.bad, 9, 'too short and padded are both against the game');
  assert.equal(length.tone, 'bad');
});

test('a neutral answer counts as a mention, but for neither side', () => {
  const comparison = topicOf(rowsOf('comparison', { better: 4, similar: 4, worse: 2, not_mentioned: 5 }), 'comparison');
  assert.deepEqual([comparison.good, comparison.bad, comparison.neutral, comparison.mentioned], [4, 2, 4, 10]);
  assert.equal(comparison.goodShare, 0.4, 'the share for the game is out of every mention, the neutral ones included');
  assert.equal(comparison.tooFew, false);
  assert.equal(comparison.tone, 'mixed');
});

test('a Yes / No topic counts its yes and no as its two options', () => {
  const rows = Array.from({ length: 12 }, (_, i) => answered(i, { positive: noul(i < 9 ? 0.8 : 0.2) }));
  const positive = topicOf(rows, 'positive');
  assert.deepEqual(positive.options.map((o) => [o.key, o.n]), [['yes', 9], ['no', 3]]);
  assert.equal(positive.share, 0.75);
});

/* ---------- performance by platform ---------- */

const platformRows = (platform, well, badly) => [
  ...Array.from({ length: well }, () => ({ platform: choice(platform), performance: choice('runs_well') })),
  ...Array.from({ length: badly }, () => ({ platform: choice(platform), performance: choice('runs_badly') })),
].map((answers, i) => answered(i, answers));

test('performance by platform pairs the platform a review names with what it says about how the game runs', () => {
  const tally = tallyRows([
    ...platformRows('steam_deck', 4, 6),
    answered(20, { platform: choice('windows_nvidia'), performance: choice('not_mentioned') }), // names hardware, says nothing about performance
    answered(21, { platform: choice('not_mentioned'), performance: choice('runs_badly') }), // says it runs badly, but not on what
    answered(22, { performance: choice('runs_badly') }), // no platform answer at all
  ]);
  assert.deepEqual(tally.platforms.steam_deck, { good: 4, bad: 6 });
  assert.deepEqual(tally.platforms.windows_nvidia, { good: 0, bad: 0 }, 'a platform with no verdict on performance is not counted');
  assert.equal(Object.values(tally.platforms).reduce((sum, p) => sum + p.good + p.bad, 0), 10, 'nothing else was counted');
});

test('a platform with enough reviews gets a row, coloured by how well it runs there; the rest are left out', () => {
  const sum = summarizeTally(tallyRows([...platformRows('steam_deck', 4, 6), ...platformRows('linux_desktop', 2, 1)]));
  const deck = sum.platforms.find((p) => p.key === 'steam_deck');
  assert.deepEqual([deck.mentioned, deck.share, deck.tooFew, deck.tone], [10, 0.6, false, 'mixed']);
  assert.equal(sum.platforms.find((p) => p.key === 'linux_desktop').tooFew, true);
  assert.equal(sum.platforms.length, STEAM_PLATFORM.options.length);
});

test('platform counts add up across batches like everything else', () => {
  const merged = mergeTallies(tallyRows(platformRows('steam_deck', 2, 3)), tallyRows(platformRows('steam_deck', 3, 4)));
  assert.deepEqual(merged.platforms.steam_deck, { good: 5, bad: 7 });
  assert.deepEqual(mergeTallies(emptyTally(), JSON.parse(JSON.stringify(merged))), merged);
});

/* ---------- what the page shows: no card without enough data ---------- */

test('a topic with too little data is left out entirely, and so is a heading with nothing under it', () => {
  const rows = Array.from({ length: 12 }, (_, i) => answered(i, { positive: noul(0.9), performance: choice('runs_badly'), platform: choice('steam_deck'), difficulty: choice(i < 3 ? 'too_hard' : 'not_mentioned') }));
  const { groups, hidden } = visibleGroups(summarizeTally(tallyRows(rows)));
  assert.deepEqual(groups.map((g) => g.id), ['overall', 'technical'], 'gameplay has difficulty, but only 3 mention it, so its heading is gone too');
  assert.deepEqual(groups[0].topics.map((t) => t.id), ['positive']);
  assert.deepEqual(groups[1].topics.map((t) => t.id), ['performance']);
  assert.deepEqual(groups[1].platforms.map((p) => p.key), ['steam_deck'], 'the platform row sits with the technical topics');
  assert.equal(hidden, 1, 'only difficulty was asked about and left out for too little data; the topics nobody was asked about are not counted');
  for (const g of groups) for (const t of g.topics) assert.equal(t.tooFew, false);
});

test('with no data at all there are no groups, and nothing counts as hidden, because nothing has been asked yet', () => {
  const { groups, hidden } = visibleGroups(summarizeTally(emptyTally()));
  assert.deepEqual(groups, []);
  assert.equal(hidden, 0);
});

test('a card appears once enough reviews mention its topic, and not before', () => {
  const at = (n) => visibleGroups(summarizeTally(tallyRows(rowsOf('story', { good_story: n, not_mentioned: 50 })))).groups.flatMap((g) => g.topics.map((t) => t.id));
  assert.equal(at(MIN_MENTIONS - 1).includes('story'), false);
  assert.equal(at(MIN_MENTIONS).includes('story'), true);
});

/* ---------- AI slop and microtransactions ---------- */

test('AI slop and microtransactions are topics of their own, kept apart from AI quality, DLC and pay to win', () => {
  const byId = Object.fromEntries(STEAM_TOPICS.map((t) => [t.id, t]));
  for (const id of ['ai_slop', 'microtransactions', 'monetization']) assert.equal(byId[id].group, 'content', id);

  // AI slop is about generative AI used to make the game, and says it is not the AI inside the game
  assert.match(byId.ai_slop.question, /AI-generated/);
  assert.match(byId.ai_slop.question, /not the enemy or companion AI/);
  assert.notEqual(byId.ai_slop.question, byId.ai_quality.question);

  // DLC and microtransactions each say what they leave to the other, so one comment is not counted under both
  assert.match(byId.monetization.question, /DLC and season passes, apart from microtransactions/);
  assert.match(byId.microtransactions.question, /in-game purchases/);
  assert.match(byId.microtransactions.question, /apart from whether they give an advantage/, 'advantage is the pay to win topic');
  assert.doesNotMatch(byId.monetization.label, /microtransaction/i);
});

test('AI slop counts the complaint, the praise for human-made work, and the neutral "uses AI, no complaint"', () => {
  const ai = topicOf(rowsOf('ai_slop', { says_ai_slop: 6, says_human_made: 2, accepts_ai: 3, not_mentioned: 40 }), 'ai_slop');
  assert.deepEqual(ai.options.map((o) => [o.key, o.n]), [['says_human_made', 2], ['says_ai_slop', 6], ['accepts_ai', 3]]);
  assert.deepEqual([ai.good, ai.bad, ai.neutral, ai.mentioned, ai.answered], [2, 6, 3, 11, 51]);
  assert.equal(ai.share, 6 / 11, 'the big number is the share who complain, which is what the title names');
  assert.equal(ai.tone, 'bad', 'and few praise it, so it reads red');
  assert.equal(ai.tooFew, false);
});

test('microtransactions get a card once enough reviews mention them, coloured by which way they lean', () => {
  const fair = topicOf(rowsOf('microtransactions', { fair_microtransactions: 9, bad_microtransactions: 1, not_mentioned: 30 }), 'microtransactions');
  assert.equal(fair.share, 0.1, 'a low share of complaints');
  assert.equal(fair.tone, 'good', 'is green');
  const few = topicOf(rowsOf('microtransactions', { bad_microtransactions: MIN_MENTIONS - 1 }), 'microtransactions');
  assert.equal(few.tooFew, true);
});

/* ---------- a server that cannot carry on from a cursor ---------- */

test('a reply with a cursor and a done flag is one the page can carry on from', () => {
  assert.equal(batchReplyProblem({ reviews: [], cursor: 'AoJwhP7736ADcf2Tgwc=', done: false }), null);
  assert.equal(batchReplyProblem({ reviews: [], cursor: '*', done: true }), null);
});

test('a reply from an older server (reviews but no cursor) is refused, with the way to fix it, rather than read again and counted twice', () => {
  for (const reply of [{ reviews: [{ id: '1' }], summary: null }, { reviews: [], cursor: 'x' }, { reviews: [], done: true }, { cursor: 5, done: false }, null, undefined]) {
    const problem = batchReplyProblem(reply);
    assert.match(problem, /older than this page/, JSON.stringify(reply));
    assert.match(problem, /Restart Jev Studio/);
  }
});

/* ---------- fun with friends ---------- */

test('fun with friends is its own topic under Gameplay, apart from matchmaking with strangers', () => {
  const byId = Object.fromEntries(STEAM_TOPICS.map((t) => [t.id, t]));
  assert.equal(byId.friends.group, 'gameplay');
  assert.equal(byId.friends.label, 'Fun with friends');
  assert.match(byId.friends.question, /with friends/);
  assert.match(byId.multiplayer.question, /matchmaking/, 'matchmaking stays its own question');
  assert.notEqual(byId.friends.question, byId.multiplayer.question);
});

test('"only fun with friends" counts as a mention but for neither side, and the big number is the share who say it is fun', () => {
  const friends = topicOf(rowsOf('friends', { fun_with_friends: 12, only_with_friends: 6, not_fun_with_friends: 2, not_mentioned: 30 }), 'friends');
  assert.deepEqual(friends.options.map((o) => [o.key, o.n]), [['fun_with_friends', 12], ['not_fun_with_friends', 2], ['only_with_friends', 6]]);
  assert.deepEqual([friends.good, friends.bad, friends.neutral, friends.mentioned], [12, 2, 6, 20]);
  assert.equal(friends.share, 0.6);
  assert.equal(friends.tone, 'mixed', 'six in twenty say it is dull alone, so it is not a clear win');
});

/* ---------- "Analyse more": the slider and the cost it shows ---------- */

test('the slider starts just above what is done, so every position means at least one more review', () => {
  assert.deepEqual(moreSlider(380123, 0), { step: 0.1, min: 0.1, max: 100, done: false });
  assert.equal(moreSlider(380123, 100).min, 0.1, 'a hundred of 380,000 is under a tenth of a percent');
  assert.equal(moreSlider(380123, 3801).min, 1, '3,801 is just under one percent (1% is 3,801.2), so one percent is still ahead');
  assert.equal(moreSlider(380123, 3802).min, 1.1, '3,802 is just over it, so the next step up is 1.1');
  assert.equal(moreSlider(500, 100).min, 21, 'a small game moves in whole percents: 100 of 500 is 20%');
  assert.equal(moreSlider(500, 0).min, 1);
  for (const [total, analysed] of [[380123, 0], [380123, 1234], [999, 10], [500, 250], [1000, 500]]) {
    const { min } = moreSlider(total, analysed);
    assert.ok(reviewsFor(total, min) > analysed, `${total} reviews, ${analysed} done: the first position is more than what is done`);
  }
});

test('the step is a tenth of a percent for a big game and a whole percent for a small one', () => {
  assert.equal(moreSlider(999, 0).step, 1);
  assert.equal(moreSlider(1000, 0).step, 0.1);
});

test('there is nothing to choose once everything is done, or when the game has no reviews', () => {
  assert.equal(moreSlider(500, 500).done, true);
  assert.equal(moreSlider(500, 600).done, true);
  assert.equal(moreSlider(0, 0).done, true);
  assert.equal(moreSlider(500, 499).done, false, 'one review left is still something to analyse');
  assert.equal(moreSlider(500, 499).min, 100);
});

test('a percentage of the game is a whole number of reviews, never more than the game has', () => {
  assert.equal(reviewsFor(380123, 0.1), 380);
  assert.equal(reviewsFor(380123, 100), 380123);
  assert.equal(reviewsFor(500, 12.4), 62);
  assert.equal(reviewsFor(500, 150), 500);
  assert.equal(reviewsFor(500, -5), 0);
});

test('token counts are said the way people say them', () => {
  assert.equal(roughTokens(1_178_000_000), '1.2 billion');
  assert.equal(roughTokens(48_400_000), '48 million');
  assert.equal(roughTokens(1_240_000), '1.2 million');
  assert.equal(roughTokens(312_400), '312,000');
  assert.equal(roughTokens(999), '1,000');
});

test('durations are rounded, in the unit that reads best', () => {
  assert.equal(roughDuration(30), 'about a minute');
  assert.equal(roughDuration(200), 'about 3 minutes');
  assert.equal(roughDuration(5400), 'about 1.5 hours');
  assert.equal(roughDuration(40_000), 'about 11 hours');
  assert.equal(roughDuration(200_000), 'about 2.3 days');
  assert.equal(roughDuration(900_000), 'about 10 days');
  assert.equal(roughDuration(0), 'no time');
  assert.equal(roughDuration(NaN), 'no time');
});

/* ---------- clicking a count: which reviews gave that answer ---------- */

test('a review has an answer when Jev chose that option, and only if the review was answered', () => {
  const row = answered(0, { pay_to_win: choice('says_pay_to_win'), positive: noul(0.8), performance: choice('not_mentioned') });
  assert.equal(rowHasAnswer(row, 'pay_to_win', 'says_pay_to_win'), true);
  assert.equal(rowHasAnswer(row, 'pay_to_win', 'says_not_pay_to_win'), false);
  assert.equal(rowHasAnswer(row, 'performance', 'not_mentioned'), true);
  assert.equal(rowHasAnswer(row, 'positive', 'yes'), true, 'a Yes / No answer counts as yes at 0.5 and above');
  assert.equal(rowHasAnswer(row, 'positive', 'no'), false);
  assert.equal(rowHasAnswer(answered(1, { positive: noul(0.49) }), 'positive', 'no'), true);
});

test('a review that was not answered, failed, or has no answer for that topic is never a match', () => {
  assert.equal(rowHasAnswer({ index: 0, status: 'pending' }, 'pay_to_win', 'says_pay_to_win'), false);
  assert.equal(rowHasAnswer({ index: 1, status: 'error', error: 'boom' }, 'pay_to_win', 'says_pay_to_win'), false);
  assert.equal(rowHasAnswer(answered(2, { positive: noul(0.9) }), 'pay_to_win', 'says_pay_to_win'), false);
  assert.equal(rowHasAnswer(answered(3, { pay_to_win: choice('says_pay_to_win') }), 'no_such_topic', 'says_pay_to_win'), false);
});

test('the reviews a click shows are exactly the ones the card counted', () => {
  const rows = [
    ...rowsOf('pay_to_win', { says_pay_to_win: 26, says_not_pay_to_win: 229, not_mentioned: 745 }),
  ];
  const tally = tallyRows(rows);
  const card = summarizeTally(tally).topics.find((t) => t.id === 'pay_to_win');
  for (const option of card.options) {
    assert.equal(rows.filter((r) => rowHasAnswer(r, 'pay_to_win', option.key)).length, option.n, option.key);
  }
  assert.equal(rows.filter((r) => rowHasAnswer(r, 'pay_to_win', 'says_pay_to_win')).length, 26);
});

/* ---------- saving an analysis, and carrying on from it ---------- */

const sliceWith = (run, extra = {}) => ({
  url: 'https://store.steampowered.com/app/548430/Deep_Rock_Galactic/', sort: 'recent', count: 100, tellThumbs: false,
  game: { appId: '548430', name: 'Deep Rock Galactic' }, summary: { scoreDesc: 'Overwhelmingly Positive', totalPositive: 9, totalNegative: 1, totalReviews: 1000 },
  key: '548430|recent', cursor: 'AoJ4zb/z36ADe9WSgwc=', exhausted: false, batches: 3, topics: [...STEAM_QUESTION_IDS], grouped: false, groupSize: 50, gtally: emptyGroupTally(), tally: tallyRows(rowsOf('story', { good_story: 12, not_mentioned: 8 })), run, ...extra,
});

test('saving keeps the batch on screen with its reviews, and the counts for the batches before it', () => {
  const run = { kind: 'steam', rows: rowsOf('story', { weak_story: 4, not_mentioned: 6 }) };
  const slice = sliceWith(run);
  const snap = snapshotOf(slice);

  assert.equal(snap.run.rows.length, 10, 'the batch is kept whole, so the saved page can show its table');
  assert.notEqual(snap.run, slice.run, 'a copy');
  assert.equal(snap.cursor, 'AoJ4zb/z36ADe9WSgwc=');
  assert.deepEqual([snap.url, snap.sort, snap.count, snap.batches, snap.key, snap.exhausted], [slice.url, 'recent', 100, 3, '548430|recent', false]);
  assert.equal(snap.tally.answered, 20, 'only the earlier batches: the one on screen is counted from its rows');
  assert.equal(snap.tally.topics.story.options.weak_story, 0);
  assert.equal(savedTally(snap).answered, 30, 'and the two together are what the analysis amounts to');
  assert.equal(savedTally(snap).topics.story.options.weak_story, 4);
});

test('a record that keeps its batch elsewhere carries the total, and the total is what is shown', () => {
  const snap = snapshotOf(sliceWith({ kind: 'steam', rows: rowsOf('story', { weak_story: 4, not_mentioned: 6 }) }));
  const { run, ...record } = snap; // what goes in the small record: the batch goes to the database
  record.total = savedTally(snap);
  assert.equal(savedTotal(record).answered, 30, 'the stored total, though the record itself holds only the earlier batches');
  assert.equal(savedTotal(JSON.parse(JSON.stringify(record))).topics.story.options.weak_story, 4, 'and it survives being stored');
  assert.equal(savedTotal(snap).answered, 30, 'a snapshot with its batch inline, or an older record, is worked out from what it holds');
  assert.equal(savedTotal({ tally: emptyTally() }).answered, 0);
});

test('carrying on from the database: the batch comes back with its table, and nothing is counted twice', () => {
  const snap = snapshotOf(sliceWith({ kind: 'steam', rows: rowsOf('story', { weak_story: 4, not_mentioned: 6 }) }));
  const { run, ...record } = snap;
  record.total = savedTally(snap);
  const fromDb = JSON.parse(JSON.stringify(run)); // stored and read back

  const restored = fieldsFromSaved(record, fromDb);
  assert.equal(restored.run.rows.length, 10);
  assert.equal(restored.tally.answered, 20, 'the earlier batches; the batch is counted from its rows');
  assert.equal(mergeTallies(restored.tally, tallyRows(restored.run.rows)).answered, 30);
  assert.equal(restored.cursor, record.cursor);
});

test('if the batch cannot be read back, its counts are folded in, so nothing already analysed is lost, and there is just no table', () => {
  const snap = snapshotOf(sliceWith({ kind: 'steam', rows: rowsOf('story', { weak_story: 4, not_mentioned: 6 }) }));
  const { run, ...record } = snap;
  record.total = savedTally(snap);
  const restored = fieldsFromSaved(record, null);
  assert.equal(restored.run, null);
  assert.equal(restored.tally.answered, 30);
  assert.equal(restored.tally.topics.story.options.weak_story, 4);
  assert.equal(restored.batches, record.batches);
});

test('the line under a review says what Steam holds, and leaves out what is not so', () => {
  assert.equal(describeSteamReview({ votedUp: true, hoursTotal: 1240.3, hoursAtReview: 80, hoursRecent: 12.5, votesUp: 34 }), 'Thumbs up on Steam · 1,240.3 h played (80 h at review, 12.5 h in the last two weeks) · 34 found it helpful');
  assert.equal(describeSteamReview({ votedUp: false, votesUp: 0, refunded: true, freeCopy: true, earlyAccess: true, steamDeck: true }), 'Thumbs down on Steam · 0 found it helpful · free copy · refunded · written in Early Access · plays on Steam Deck');
  assert.equal(describeSteamReview(undefined), '');
  assert.match(describeSteamReview({ votedUp: true, hoursTotal: 5, hoursAtReview: null, hoursRecent: null, votesUp: 1 }), /5 h played \(\? at review, \? in the last two weeks\)/);
});

test('the filter for a clicked count matches those reviews, and only mentions batches when there is more than one', () => {
  const topic = STEAM_TOPICS.find((t) => t.id === 'pay_to_win');
  const option = topic.options.find((o) => o.key === 'says_pay_to_win');
  const one = steamFilter(topic, option);
  assert.equal(one.label, 'Pay to win');
  assert.equal(one.note, '');
  const rows = rowsOf('pay_to_win', { says_pay_to_win: 3, says_not_pay_to_win: 5, not_mentioned: 7 });
  assert.equal(rows.filter(one.test).length, 3);
  assert.match(steamFilter(topic, option, { batches: 4 }).note, /covers every batch; the table holds only this one/);
  assert.match(steamFilter(topic, option, { batches: 4, where: 'the saved one' }).note, /only the saved one/);
});

test('a batch stopped part way keeps its rows, because the reviews not yet asked about are already behind the cursor', () => {
  const rows = [...rowsOf('story', { good_story: 3 }), { index: 3, text: 'not yet', status: 'pending' }, { index: 4, text: 'was running', status: 'running' }];
  const slice = sliceWith({ kind: 'steam', rows });
  const snap = snapshotOf(slice);

  assert.equal(snap.run.rows.length, 5);
  assert.deepEqual(snap.run.rows.slice(3).map((r) => r.status), ['pending', 'pending'], 'nothing is running in a saved copy');
  assert.equal(snap.tally.answered, 20, 'the counts are the earlier batches only: this one is still counted from its rows');
  assert.equal(savedTally(snap).answered, 23, 'and the batch adds its answered reviews back when the totals are read');
});

test('saving changes nothing on the page', () => {
  const rows = [...rowsOf('story', { good_story: 3 }), { index: 3, text: 'not yet', status: 'running' }];
  const slice = sliceWith({ kind: 'steam', rows });
  const before = JSON.stringify(slice);
  const snap = snapshotOf(slice);
  snap.run.rows[0].text = 'changed in the copy';
  snap.tally.answered = 999;
  assert.equal(JSON.stringify(slice), before, 'the page is as it was, including the row that was running');
});

test('saved, read back and continued: no review is lost or counted twice', () => {
  const finished = sliceWith({ kind: 'steam', rows: rowsOf('story', { weak_story: 4, not_mentioned: 6 }) });
  const stopped = sliceWith({ kind: 'steam', rows: [...rowsOf('story', { weak_story: 4 }), { index: 4, text: 'not yet', status: 'pending' }] });
  for (const slice of [finished, stopped]) {
    const onPage = mergeTallies(slice.tally, tallyRows(slice.run.rows)); // what the page adds up to before saving
    const restored = fieldsFromSaved(JSON.parse(JSON.stringify(snapshotOf(slice)))); // saved to storage, read back, put on the page
    const afterwards = mergeTallies(restored.tally, restored.run ? tallyRows(restored.run.rows) : null);
    assert.deepEqual(afterwards, onPage);
    assert.equal(restored.cursor, slice.cursor);
    assert.equal(restored.batches, slice.batches);
  }
});

test('continuing does not change the saved analysis, and a saved one with things missing still loads', () => {
  const saved = snapshotOf(sliceWith({ kind: 'steam', rows: [...rowsOf('story', { good_story: 2 }), { index: 2, text: 'p', status: 'pending' }] }));
  const restored = fieldsFromSaved(saved);
  restored.run.rows[0].text = 'changed';
  restored.tally.answered = 0;
  assert.notEqual(saved.run.rows[0].text, 'changed');
  assert.notEqual(saved.tally.answered, 0);

  const bare = fieldsFromSaved({ url: 'u', sort: 'recent', count: 50 });
  assert.deepEqual([bare.cursor, bare.batches, bare.exhausted, bare.run, bare.game, bare.tellThumbs], ['*', 0, false, null, null, false]);
  assert.deepEqual(bare.tally, emptyTally());
});

test('what a saved analysis holds is small, however many reviews it covers', () => {
  const big = sliceWith(null, { tally: mergeTallies(emptyTally(), tallyRows(Array.from({ length: 5000 }, (_, i) => okRow(i, { positive: noul(0.9), pay_to_win: choice('says_pay_to_win') })))), batches: 50 });
  const size = JSON.stringify(snapshotOf(big)).length;
  assert.ok(size < 20_000, `${size} characters for 5,000 reviews`);
});

test('the filter bar names a clicked count by the option alone when it already says the topic, else topic and option', () => {
  const topic = (id) => STEAM_TOPICS.find((t) => t.id === id);
  const label = (id, key) => pickLabel(topic(id), topic(id).options.find((o) => o.key === key));
  assert.equal(label('positive', 'yes'), 'Positive');
  assert.equal(label('pay_to_win', 'says_pay_to_win'), 'Pay to win');
  assert.equal(label('pay_to_win', 'says_not_pay_to_win'), 'Not pay to win');
  assert.equal(label('performance', 'runs_badly'), 'Runs badly');
  assert.equal(label('difficulty', 'too_hard'), 'Difficulty: Too hard');
  for (const t of STEAM_TOPICS) for (const o of t.options) assert.ok(pickLabel(t, o).includes(o.label), `${t.id}/${o.key} still says which answer it is`);
});

/* ---------- the menu of answers to show in the table ---------- */

test('there is a choice for every answer of every topic, and each finds exactly the reviews that gave it', () => {
  const choices = steamFilterChoices();
  assert.deepEqual(choices.map((g) => g.group), STEAM_TOPICS.map((t) => t.label), 'one group per topic, in order');
  const keys = choices.flatMap((g) => g.items.map((i) => i.filter.key));
  assert.equal(new Set(keys).size, keys.length, 'every choice has its own key, so the menu can show which is selected');
  for (const t of STEAM_TOPICS) for (const o of t.options) assert.ok(keys.includes(`${t.id}:${o.key}`), `${t.id}/${o.key}`);

  const rows = [
    ...rowsOf('community', { friendly_community: 4, toxic_community: 2, not_mentioned: 9 }),
    ...rowsOf('dev_responsiveness', { unresponsive: 3, responsive: 5 }).map((r) => ({ ...r, index: r.index + 100 })),
  ];
  const item = (group, label) => choices.find((g) => g.group === group).items.find((i) => i.label === label);
  assert.equal(rows.filter(item('Community', 'Friendly').filter.test).length, 4, 'friendly');
  assert.equal(rows.filter(item('Community', 'Toxic').filter.test).length, 2, 'toxic');
  assert.equal(rows.filter(item('Developer responsiveness', 'Unresponsive').filter.test).length, 3, 'unresponsive devs');
});

test('a choice made from the menu is the same filter as a click on a card, so the menu shows it as selected either way', () => {
  const topic = STEAM_TOPICS.find((t) => t.id === 'community');
  const option = topic.options.find((o) => o.key === 'toxic_community');
  const clicked = steamFilter(topic, option, { batches: 3 });
  const chosen = steamFilterChoices({ batches: 3 }).find((g) => g.group === 'Community').items.find((i) => i.label === 'Toxic').filter;
  assert.equal(chosen.key, clicked.key);
  assert.equal(chosen.label, clicked.label);
  assert.equal(chosen.note, clicked.note);
  assert.equal(clicked.key, 'community:toxic_community');
});

test('the menu only mentions batches when there is more than one', () => {
  const note = (opts) => steamFilterChoices(opts)[0].items[0].filter.note;
  assert.equal(note({ batches: 1 }), '');
  assert.match(note({ batches: 2, where: 'the batch it was saved with' }), /only the batch it was saved with/);
});

/* ---------- switching questions on and off ---------- */

const SIX = ['positive', 'worth_price', 'pay_to_win', 'performance', 'stability', 'replayability'];

test('with no choice made every question is asked, and switching some off asks only the others, in the same order', () => {
  assert.deepEqual(Object.keys(steamQuestions()), STEAM_QUESTION_IDS);
  assert.deepEqual(Object.keys(steamQuestions(null)), STEAM_QUESTION_IDS);
  assert.deepEqual(Object.keys(steamQuestions(['pay_to_win', 'positive'])), ['positive', 'pay_to_win'], 'the topics keep their own order, not the order they were ticked');
  assert.deepEqual(Object.keys(steamQuestions([])), []);
  assert.deepEqual(Object.keys(steamQuestions(['nonsense'])), [], 'an id that is not a question asks nothing');
  assert.equal(validateRequest({ state: 'x', questions: steamQuestions(SIX) }).ok, true);
});

test('the platform question is its own switch', () => {
  assert.ok(steamQuestions(['performance', STEAM_PLATFORM.id])[STEAM_PLATFORM.id]);
  assert.equal(STEAM_PLATFORM.id in steamQuestions(['performance']), false);
  assert.deepEqual(STEAM_QUESTION_IDS.at(-1), STEAM_PLATFORM.id);
  assert.equal(STEAM_QUESTION_IDS.length, STEAM_TOPICS.length + 1);
});

test('the composite defaults cover exactly the questions that are on', () => {
  for (const enabled of [null, SIX, ['difficulty'], ['positive', STEAM_PLATFORM.id]]) {
    assert.deepEqual(Object.keys(steamSpecs(enabled)), Object.keys(steamQuestions(enabled)));
  }
});

test('the signature says which questions are on, whatever order they were ticked in', () => {
  assert.equal(questionSignature(['pay_to_win', 'positive']), questionSignature(['positive', 'pay_to_win']));
  assert.notEqual(questionSignature(['positive']), questionSignature(['positive', 'pay_to_win']));
  assert.equal(questionSignature(null), questionSignature([...STEAM_QUESTION_IDS]));
});

test('a topic that is switched off has no card, and is not counted as one that is missing for want of data', () => {
  const rows = Array.from({ length: 12 }, (_, i) => answered(i, { positive: noul(0.9), performance: choice('runs_badly') }));
  const { groups, hidden } = visibleGroups(summarizeTally(tallyRows(rows)));
  assert.deepEqual(groups.flatMap((g) => g.topics.map((t) => t.id)), ['positive', 'performance']);
  assert.equal(hidden, 0, 'the other twenty-one were never asked, so there is nothing to say about them');
});

/* ---------- grouping reviews ---------- */

const bandAnswer = (band) => ({ type: 'score', score: band, confidence: 1, legend: {}, probabilities: Object.fromEntries(SHARE_BANDS.map((_, i) => [String(i), i === band ? 1 : 0])) });
/** A group row: `size` reviews, and Jev's answer (a band from 0 to 5) to the good-side and bad-side question of each topic given. */
const groupRow = (index, size, bands = {}, extra = {}) => ({
  index, size, texts: Array.from({ length: size }, (_, i) => `review ${i}`), status: 'ok',
  response: { answers: Object.fromEntries(Object.entries(bands).flatMap(([id, [good, bad]]) => [[`${id}_good`, bandAnswer(good)], [`${id}_bad`, bandAnswer(bad)]])), usage: { input_tokens: 900, output_tokens: 100 } },
  ...extra,
});

test('a group is two share questions per topic, each answered as a band, and they are valid requests', () => {
  const questions = steamGroupQuestions();
  assert.equal(Object.keys(questions).length, STEAM_TOPICS.length * 2);
  assert.deepEqual(Object.keys(steamGroupQuestions(['friends', 'pay_to_win'])), ['pay_to_win_good', 'pay_to_win_bad', 'friends_good', 'friends_bad'], 'in the topics\' own order, two for each');
  assert.equal(validateRequest({ state: 'x', questions }).ok, true);
  for (const q of Object.values(questions)) {
    assert.equal(q.type, 'score');
    assert.equal(q.criteria.length, SHARE_BANDS.length);
    assert.match(q.instructions, /What share of the reviews below match/);
  }
  // the question quotes what counts, so it is the same judgment as reading the reviews one by one
  const p2w = steamGroupQuestions(['pay_to_win']);
  assert.match(p2w.pay_to_win_bad.instructions, /Says spending money gives an advantage/);
  assert.match(p2w.pay_to_win_good.instructions, /fair to players who pay nothing/);
  const diff = steamGroupQuestions(['difficulty']);
  assert.match(diff.difficulty_bad.instructions, / or /, 'a side with two answers (too easy, too hard) is asked as either');
  assert.match(diff.difficulty_bad.instructions, /too easy/i);
  assert.match(diff.difficulty_bad.instructions, /too hard/i);
});

test('the bands rise, and each has a middle inside it', () => {
  const mids = SHARE_BANDS.map((b) => b.mid);
  assert.deepEqual(mids, [...mids].sort((a, b) => a - b));
  assert.ok(SHARE_BANDS.length >= 2 && SHARE_BANDS.length <= 10, 'the API takes 2 to 10 levels');
  assert.ok(mids[0] > 0 && mids.at(-1) < 1);
});

test('a group is the reviews, numbered, with the game named, and nothing else about them', () => {
  assert.equal(buildGroupState('Deep Rock Galactic', ['  good  ', 'Great co-op']), '2 Steam reviews of Deep Rock Galactic, numbered:\n\n1. good\n2. Great co-op');
  assert.equal(buildGroupState(null, ['x']), '1 Steam reviews of a game, numbered:\n\n1. x');
  assert.doesNotMatch(buildGroupState('X', ['fine']), /thumb|hours|helpful|voted/i);
});

test('a long review is cut for a group, and a short one is left', () => {
  assert.equal(clipForGroup('short'), 'short');
  const clipped = clipForGroup('word '.repeat(400));
  assert.ok(clipped.length <= GROUP_REVIEW_MAX_CHARS);
  assert.ok(clipped.endsWith('…'));
});

test('reviews are cut into groups of a size, and the last is what is left', () => {
  const reviews = Array.from({ length: 120 }, (_, i) => i);
  assert.deepEqual(chunkReviews(reviews, 50).map((g) => g.length), [50, 50, 20]);
  assert.deepEqual(chunkReviews(reviews, 25).length, 5);
  assert.deepEqual(chunkReviews([], 50), []);
  assert.deepEqual(chunkReviews(reviews, 50).flat(), reviews, 'nothing lost or repeated');
});

test('a share is worked out from the bands Jev spreads its answer over, weighted, and does not need them to add up to one', () => {
  assert.equal(shareFromAnswer(bandAnswer(0)), SHARE_BANDS[0].mid);
  assert.equal(shareFromAnswer(bandAnswer(5)), SHARE_BANDS[5].mid);
  const half = { probabilities: { 2: 0.5, 4: 0.5 } };
  assert.ok(Math.abs(shareFromAnswer(half) - (SHARE_BANDS[2].mid + SHARE_BANDS[4].mid) / 2) < 1e-9);
  const unnormalised = { probabilities: { 2: 1, 4: 1 } };
  assert.ok(Math.abs(shareFromAnswer(unnormalised) - shareFromAnswer(half)) < 1e-9, 'only the proportions matter');
});

test('with no probabilities the share comes from the score, between the two bands it lies between; with neither there is none', () => {
  assert.equal(shareFromAnswer({ score: 2 }), SHARE_BANDS[2].mid);
  const between = shareFromAnswer({ score: 2.5 });
  assert.ok(between > SHARE_BANDS[2].mid && between < SHARE_BANDS[3].mid);
  assert.equal(shareFromAnswer({ score: 99 }), SHARE_BANDS.at(-1).mid, 'a score off the end is the top band');
  assert.equal(shareFromAnswer({}), null);
  assert.equal(shareFromAnswer(undefined), null);
  assert.equal(shareFromAnswer({ probabilities: { 0: 0, 1: 0 } }), null, 'all zero says nothing');
});

test('group counts are estimates of reviews: the share times the size of the group, added up over the groups', () => {
  const rows = [groupRow(0, 50, { pay_to_win: [0, 3] }), groupRow(1, 50, { pay_to_win: [0, 3] }), groupRow(2, 20, { pay_to_win: [0, 3] })];
  const tally = groupTallyRows(rows);
  assert.deepEqual([tally.groups, tally.reviews, tally.failed, tally.tokens], [3, 120, 0, 3000]);
  const p2w = tally.topics.pay_to_win;
  assert.equal(p2w.reviews, 120);
  assert.ok(Math.abs(p2w.bad - 120 * SHARE_BANDS[3].mid) < 1e-9, 'a band of 20-40% in every group, so about 30% of 120 reviews');
  assert.ok(Math.abs(p2w.good - 120 * SHARE_BANDS[0].mid) < 1e-9);
  assert.equal(tally.topics.difficulty.reviews, 0, 'a topic that was not asked is not counted');
});

test('two shares that add to more than everyone are scaled down, so a topic never counts more reviews than the group has', () => {
  const tally = groupTallyRows([groupRow(0, 50, { pay_to_win: [5, 5] })]);
  const { good, bad } = tally.topics.pay_to_win;
  assert.ok(good + bad <= 50 + 1e-9);
  assert.ok(Math.abs(good - bad) < 1e-9, 'in the same proportion as they were given');
});

test('a failed group is counted with its reviews, an unanswered one is not, and an answer that is missing is skipped', () => {
  const rows = [groupRow(0, 50, { positive: [4, 1] }), { index: 1, size: 50, texts: [], status: 'error', error: 'boom' }, { index: 2, size: 50, texts: [], status: 'pending' }, groupRow(3, 30, {}, { response: { answers: { positive_good: bandAnswer(4) }, usage: { input_tokens: 1, output_tokens: 1 } } })];
  const tally = groupTallyRows(rows);
  assert.deepEqual([tally.groups, tally.reviews, tally.failed, tally.failedReviews], [2, 80, 1, 50]);
  assert.equal(tally.topics.positive.reviews, 50, 'the group with only one of the two answers says nothing about the topic');
});

test('group tallies add up across batches like the others do, changing neither, and cope with one that is missing or partial', () => {
  const a = groupTallyRows([groupRow(0, 50, { pay_to_win: [0, 3] })]);
  const b = groupTallyRows([groupRow(0, 50, { pay_to_win: [1, 2] }), groupRow(1, 50, { pay_to_win: [1, 2] })]);
  const before = JSON.stringify(a);
  const together = mergeGroupTallies(a, b);
  assert.equal(JSON.stringify(a), before);
  assert.deepEqual(together, groupTallyRows([groupRow(0, 50, { pay_to_win: [0, 3] }), groupRow(1, 50, { pay_to_win: [1, 2] }), groupRow(2, 50, { pay_to_win: [1, 2] })]));
  assert.deepEqual(mergeGroupTallies(a, null), a);
  assert.deepEqual(mergeGroupTallies(emptyGroupTally(), { groups: 2 }).groups, 2);
  assert.deepEqual(mergeGroupTallies(emptyGroupTally(), JSON.parse(JSON.stringify(together))), together, 'and survive being stored');
});

test('the summary of groups has the fields of the summary of reviews, so the same cards show it, and says it is an estimate', () => {
  const tally = groupTallyRows(Array.from({ length: 4 }, (_, i) => groupRow(i, 50, { pay_to_win: [1, 4], positive: [4, 1] })));
  const groups = summarizeTally(tallyRows(rowsOf('story', { good_story: 12, not_mentioned: 8 })));
  const guess = summarizeGroupTally(tally);
  assert.equal(guess.approximate, true);
  assert.equal(groups.approximate, undefined);
  assert.deepEqual(Object.keys(guess.topics[0]).sort(), Object.keys(groups.topics[0]).sort(), 'every field a card reads is there');
  assert.equal(guess.answered, 200);
  assert.deepEqual(guess.platforms, [], 'performance by platform needs each review on its own');

  const p2w = guess.topics.find((t) => t.id === 'pay_to_win');
  assert.deepEqual(p2w.options.map((o) => [o.tone, o.label]), [['good', 'Not pay to win'], ['bad', 'Pay to win']]);
  assert.ok(Math.abs(p2w.share - p2w.bad / (p2w.good + p2w.bad)) < 1e-12, 'the headline share is among the reviews that take a side, as for reviews read one by one');
  assert.equal(p2w.tooFew, false);
  assert.equal(p2w.tone, 'bad', 'a lot more say it is pay to win than not');
  assert.equal(guess.topics.find((t) => t.id === 'difficulty').tooFew, true, 'not asked, so no card');
});

test('a topic needs enough mentions in an estimate too, counted as the reviews it puts on a side', () => {
  const few = summarizeGroupTally(groupTallyRows([groupRow(0, 50, { pay_to_win: [0, 0] })])).topics.find((t) => t.id === 'pay_to_win');
  assert.equal(few.tooFew, true, 'about one review on a side is not enough for a percentage');
  assert.equal(few.tone, 'none');
  const many = summarizeGroupTally(groupTallyRows([groupRow(0, 50, { pay_to_win: [1, 3] })])).topics.find((t) => t.id === 'pay_to_win');
  assert.equal(many.tooFew, false);
});

test('grouped cards go through the same rules for what is shown: nothing without enough data, and headings with nothing under them are dropped', () => {
  const guess = summarizeGroupTally(groupTallyRows(Array.from({ length: 3 }, (_, i) => groupRow(i, 50, { positive: [4, 1] }))));
  const { groups, hidden } = visibleGroups(guess);
  assert.deepEqual(groups.map((g) => g.id), ['overall']);
  assert.deepEqual(groups[0].topics.map((t) => t.id), ['positive']);
  assert.equal(hidden, 0);
});

/* ---------- what it costs ---------- */

test('fewer questions cost less, groups cost far less, and bigger groups less again', () => {
  const each = tokensPerReviewEstimate({});
  const eachSix = tokensPerReviewEstimate({ topics: SIX });
  assert.ok(eachSix < each / 2, `${eachSix} against ${each}`);
  const g25 = tokensPerReviewEstimate({ grouped: true, groupSize: 25 });
  const g50 = tokensPerReviewEstimate({ grouped: true, groupSize: 50 });
  const g100 = tokensPerReviewEstimate({ grouped: true, groupSize: 100 });
  const g200 = tokensPerReviewEstimate({ grouped: true, groupSize: 200 });
  const g400 = tokensPerReviewEstimate({ grouped: true, groupSize: 400 });
  assert.ok(g25 > g50 && g50 > g100 && g100 > g200 && g200 > g400, `${g25} > ${g50} > ${g100} > ${g200} > ${g400}`);
  assert.ok(each / g50 > 15, `groups of 50 are ${(each / g50).toFixed(0)} times cheaper`);
  assert.ok(tokensPerReviewEstimate({ grouped: true, groupSize: 50, topics: SIX }) < g50);
});

test('the estimate agrees with what the original six questions really cost, 1,167 tokens a review on a real run', () => {
  assert.ok(Math.abs(tokensPerReviewEstimate({ topics: SIX }) - 1167) <= 25, String(tokensPerReviewEstimate({ topics: SIX })));
  assert.ok(Math.abs(tokensPerReviewEstimate({}) - 3200) <= 100, 'and with every question it is about what the page always assumed');
});

/* ---------- saving and carrying on with these settings ---------- */

test('saving keeps which questions are on and how reviews are grouped, and carrying on puts them back', () => {
  const slice = sliceWith(null, { topics: SIX, grouped: true, groupSize: 25 });
  const restored = fieldsFromSaved(JSON.parse(JSON.stringify(snapshotOf(slice))));
  assert.deepEqual(restored.topics, SIX);
  assert.equal(restored.grouped, true);
  assert.equal(restored.groupSize, 25);
  assert.equal(fieldsFromSaved({ groupSize: 200 }).groupSize, 200, 'a group of 200 is kept, not put back to 50');
  assert.equal(fieldsFromSaved({ groupSize: 400 }).groupSize, 400);
  assert.equal(fieldsFromSaved({ groupSize: 75 }).groupSize, 50, 'a size that is not offered is');
  const older = fieldsFromSaved({ url: 'u', sort: 'recent', count: 50 });
  assert.deepEqual([older.topics.length, older.grouped, older.groupSize], [STEAM_QUESTION_IDS.length, false, 50], 'an older save has every question on and no grouping');
  assert.deepEqual(fieldsFromSaved({ topics: ['pay_to_win', 'made_up'] }).topics, ['pay_to_win'], 'a question that no longer exists is dropped');
});

test('a finished batch of groups has no table, so saving folds it into the group counts and keeps no rows', () => {
  const rows = [groupRow(0, 50, { pay_to_win: [1, 3] }), groupRow(1, 50, { pay_to_win: [1, 3] })];
  const before = groupTallyRows([groupRow(9, 50, { pay_to_win: [1, 3] })]);
  const slice = sliceWith({ kind: 'steamgroup', rows }, { grouped: true, gtally: before });
  const snap = snapshotOf(slice);
  assert.equal(snap.run, null);
  assert.equal(snap.gtally.reviews, 150, 'the earlier batches and the one on screen');
  assert.equal(savedGroupTotal(snap).reviews, 150);
  assert.equal(savedTotal(snap).answered, slice.tally.answered, 'and the reviews read one by one are untouched');
});

test('a batch of groups stopped part way is kept, so the groups not yet asked about are not lost, and nothing is counted twice', () => {
  const rows = [groupRow(0, 50, { pay_to_win: [1, 3] }), { index: 1, size: 50, texts: ['a'], status: 'pending' }, { index: 2, size: 50, texts: ['b'], status: 'running' }];
  const slice = sliceWith({ kind: 'steamgroup', rows }, { grouped: true });
  const snap = snapshotOf(slice);
  assert.equal(snap.run.rows.length, 3);
  assert.deepEqual(snap.run.rows.map((r) => r.status), ['ok', 'pending', 'pending']);
  assert.equal(snap.gtally.reviews, 0, 'the earlier batches only');
  assert.equal(savedGroupTotal(snap).reviews, 50, 'plus the group on screen that was answered');
  assert.equal(savedTally(snap).answered, slice.tally.answered, 'group rows are never counted as reviews read one by one');

  const restored = fieldsFromSaved(JSON.parse(JSON.stringify(snap)));
  assert.equal(restored.run.kind, 'steamgroup');
  assert.equal(mergeGroupTallies(restored.gtally, groupTallyRows(restored.run.rows)).reviews, 50);
  assert.equal(restored.tally.answered, slice.tally.answered);
});

test('a saved analysis that read reviews both ways keeps both counts, and neither is lost when the batch cannot be read back', () => {
  const groupsDone = groupTallyRows([groupRow(0, 50, { pay_to_win: [1, 3] })]);
  const slice = sliceWith({ kind: 'steam', rows: rowsOf('story', { weak_story: 4, not_mentioned: 6 }) }, { gtally: groupsDone });
  const snap = snapshotOf(slice);
  const { run, ...record } = snap;
  record.total = savedTally(snap);
  record.gtotal = savedGroupTally(snap);
  const restored = fieldsFromSaved(record, null);
  assert.equal(restored.run, null);
  assert.equal(restored.tally.answered, 30);
  assert.equal(restored.gtally.reviews, 50);
});

test('groups are cut inside a batch, so a batch of 500 in groups of 200 is three requests, not two and a half', () => {
  assert.deepEqual(groupPlan(500, 500, 200), [{ size: 200, count: 2 }, { size: 100, count: 1 }]);
  assert.equal(groupRequests(500, 500, 200), 3);
  assert.equal(groupRequests(500, 500, 100), 5, 'a size that divides the batch wastes nothing');
  assert.equal(groupRequests(50, 50, 200), 1, 'a group bigger than the batch is the batch');
  assert.equal(groupRequests(0, 500, 200), 0);
});

test('the whole of a big game: 482,604 reviews in batches of 500 and groups of 200 is 2,896 requests, not the 2,414 that ignoring batches gives', () => {
  const plan = groupPlan(482604, 500, 200);
  assert.equal(plan.reduce((n, g) => n + g.count * g.size, 0), 482604, 'every review is in exactly one group');
  assert.equal(groupRequests(482604, 500, 200), 2896);
  assert.ok(2896 > Math.ceil(482604 / 200));
});

test('the short group at the end of each batch makes reading it a little dearer than the full-group estimate', () => {
  const full = tokensPerReviewEstimate({ grouped: true, groupSize: 200 }) * 500;
  const real = groupTokensEstimate(500, 500, 200);
  assert.ok(real > full, `${real} > ${full}`);
  assert.equal(groupTokensEstimate(400, 200, 200), tokensPerReviewEstimate({ grouped: true, groupSize: 200 }) * 400, 'and with nothing left over it is the plain estimate');
});

test('a group of 400 shortens each review so the request stays under what the API accepts; smaller groups are cut as before', () => {
  for (const size of [25, 50, 100, 200]) assert.equal(groupClipChars(size), GROUP_REVIEW_MAX_CHARS, `groups of ${size} keep the usual cut`);
  assert.equal(groupClipChars(400), 350);
  // The worst case: 400 very long reviews. Whatever their length, the text Jev is sent stays within the budget (plus the numbering).
  const long = 'word '.repeat(2000);
  for (const size of STEAM_GROUP_SIZES) {
    const state = buildGroupState('A game', Array.from({ length: size }, () => clipForGroup(long, groupClipChars(size))));
    assert.ok(state.length <= GROUP_MAX_CHARS + size * 8, `${size}: ${state.length} characters`);
  }
});
