import test from 'node:test';
import assert from 'node:assert/strict';
import { lintQuestion } from '../public/lib/lint.js';
import { compareRuns } from '../public/lib/compare.js';
import { EDIT_PAGE_LABEL, editPageOf, exportSet, parseSetFile, removeSet, SET_FORMAT, upsertSet } from '../public/lib/library.js';
import { batchCsvRows, resultsToText } from '../public/lib/export.js';
import { buildRankState, rankQuestions, rankSpecs } from '../public/lib/rank.js';
import { addUsage, emptyUsage, formatTokens } from '../public/lib/usage.js';
import { draftFromRequest, newQuestion } from '../public/request.js';
import { TEMPLATES } from '../public/templates.js';
import { parseCsv, toCsv } from '../public/lib/csv.js';
import { validateRequest } from '../src/validate.js';

/* ---------- lint ---------- */

const q = (over) => newQuestion({ id: 'q', instructions: 'Does the message mention a refund?', ...over });
const messages = (question, level) => lintQuestion(question).filter((n) => !level || n.level === level).map((n) => n.message);

test('no built-in example produces a warning (the linter must not nag on good questions)', () => {
  for (const tpl of TEMPLATES) {
    for (const question of draftFromRequest(tpl.request).questions) {
      assert.deepEqual(messages(question, 'warn'), [], `${tpl.name}/${question.id}`);
    }
  }
});

test('lint: short text, several question marks, and "and" between two judgments', () => {
  assert.match(messages(q({ type: 'noul', instructions: 'Urgent?' }), 'warn')[0], /Very short/);
  assert.ok(messages(q({ type: 'noul', instructions: 'Is it urgent? Is it big?' }), 'warn').some((m) => /question mark/.test(m)));
  assert.ok(messages(q({ type: 'noul', instructions: 'Is the customer angry and asking for a refund?' }), 'warn').some((m) => /"and"/.test(m)));
  // "and" is fine inside a Choice question, and "or" alone is a single either/or judgment
  assert.equal(messages(q({ type: 'choice', instructions: 'Which team handles billing and refunds?' }), 'warn').length, 0);
  assert.equal(messages(q({ type: 'noul', instructions: 'Does the message ask for a refund or a replacement?' }), 'warn').length, 0);
});

test('lint: a Yes / No question should not start with what/which/how', () => {
  assert.ok(messages(q({ type: 'noul', instructions: 'How urgent is this ticket?' }), 'warn').some((m) => /answerable with yes or no/.test(m)));
  assert.ok(messages(q({ type: 'score', instructions: 'Is this ticket urgent at all?' }), 'info').some((m) => /Yes \/ No type/.test(m)));
});

test('lint: Choice options - catch-all, undescribed, and a hidden yes/no', () => {
  const opts = (...keys) => keys.map((key) => ({ key, desc: 'described' }));
  assert.ok(messages(q({ options: opts('billing', 'tech', 'sales') }), 'info').some((m) => /"other" option/.test(m)));
  assert.equal(messages(q({ options: opts('billing', 'tech', 'other') }), 'info').filter((m) => /other/.test(m)).length, 0);
  assert.ok(messages(q({ options: [{ key: 'a', desc: '' }, { key: 'b', desc: 'x' }, { key: 'other', desc: '' }] }), 'info').some((m) => /2 options without a description/.test(m)));
  assert.ok(messages(q({ options: opts('yes', 'no') }), 'info').some((m) => /Yes \/ No type/.test(m)));
});

test('lint: Score levels - vague, duplicated, too few, too many', () => {
  const lv = (...levels) => q({ type: 'score', instructions: 'How frustrated is the customer?', levels });
  assert.ok(messages(lv('calm', 'Clearly upset about the third delay', 'Threatening to cancel the account'), 'warn').some((m) => /Level 0 is vague/.test(m)));
  assert.ok(messages(lv('same words here', 'Same words here', 'another distinct level'), 'warn').some((m) => /same description/.test(m)));
  assert.ok(messages(lv('one two three', 'four five six'), 'info').some((m) => /Only 2 levels/.test(m)));
  assert.ok(messages(lv(...Array.from({ length: 8 }, (_, i) => `level number ${i}`)), 'info').some((m) => /Many levels/.test(m)));
});

test('lint: a Yes / No without meanings gets a hint; an empty question gets no text-based notes', () => {
  assert.ok(messages(q({ type: 'noul' }), 'info').some((m) => /what "yes" and "no" mean/.test(m)));
  assert.equal(messages(q({ type: 'noul', instructions: '', noul: { yes: 'a', no: 'b' } })).length, 0);
});

/* ---------- compare ---------- */

const run = (state, questions, answers) => ({ request: { state, questions }, response: { answers } });
const choiceQ = (instructions = 'Team?', criteria = { billing: null, tech: null }) => ({ type: 'choice', instructions, criteria });

test('compareRuns: Yes / No delta and flip, Choice option deltas sorted by size, changed top choice', () => {
  const qs = { urgent: { type: 'noul', instructions: 'Urgent?' }, dept: choiceQ() };
  const a = run('x', qs, {
    urgent: { type: 'noul', noul: 0.4 },
    dept: { type: 'choice', choice: 'billing', confidence: 0.5, probabilities: { billing: 0.7, tech: 0.3 } },
  });
  const b = run('y', qs, {
    urgent: { type: 'noul', noul: 0.8 },
    dept: { type: 'choice', choice: 'tech', confidence: 0.6, probabilities: { billing: 0.2, tech: 0.8 } },
  });
  const cmp = compareRuns(a, b);
  assert.equal(cmp.inputChanged, true);

  const urgent = cmp.questions.find((x) => x.id === 'urgent');
  assert.ok(Math.abs(urgent.delta - 0.4) < 1e-9);
  assert.equal(urgent.flipped, true);

  const dept = cmp.questions.find((x) => x.id === 'dept');
  assert.equal(dept.changed, true);
  assert.equal(dept.choiceA, 'billing');
  assert.equal(dept.choiceB, 'tech');
  assert.equal(dept.options.length, 2);
  assert.ok(Math.abs(dept.options[0].delta) >= Math.abs(dept.options[1].delta), 'biggest movers first');
});

test('compareRuns notices reworded questions, changed criteria, added/removed questions and type changes', () => {
  const answers = { dept: { type: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 1, tech: 0 } } };
  const a = run('same', { dept: choiceQ('Team?'), only_a: { type: 'noul', instructions: 'x' }, kind: { type: 'noul', instructions: 'k' } }, answers);
  const b = run('same', { dept: choiceQ('Which team?', { billing: 'Payments', tech: null }), only_b: { type: 'noul', instructions: 'y' }, kind: { type: 'score', instructions: 'k', criteria: ['a', 'b'] } }, answers);
  const cmp = compareRuns(a, b);
  assert.equal(cmp.inputChanged, false);
  const byId = Object.fromEntries(cmp.questions.map((x) => [x.id, x]));
  assert.equal(byId.dept.wordingChanged, true);
  assert.equal(byId.dept.criteriaChanged, true);
  assert.equal(byId.only_a.status, 'only-a');
  assert.equal(byId.only_b.status, 'only-b');
  assert.equal(byId.kind.status, 'type-changed');
});

test('compareRuns for Score gives value delta and per-level rows in level order with labels', () => {
  const qs = { mood: { type: 'score', instructions: 'Mood?', criteria: ['calm', 'angry'] } };
  const mk = (score, p) => ({ type: 'score', score, confidence: 0.5, legend: { 0: 'calm', 1: 'angry' }, probabilities: p });
  const cmp = compareRuns(run('x', qs, { mood: mk(0.3, { 0: 0.7, 1: 0.3 }) }), run('x', qs, { mood: mk(0.9, { 0: 0.1, 1: 0.9 }) }));
  const mood = cmp.questions[0];
  assert.ok(Math.abs(mood.delta - 0.6) < 1e-9);
  assert.deepEqual(mood.options.map((o) => o.key), ['0', '1']);
  assert.deepEqual(mood.options.map((o) => o.label), ['calm', 'angry']);
});

/* ---------- saved question sets ---------- */

const goodQuestions = () => ({
  dept: { type: 'choice', instructions: 'Team?', criteria: { billing: 'Payments', tech: null } },
  urgent: { type: 'noul', instructions: 'Urgent?', criteria: { true: 'yes', false: 'no' } },
  mood: { type: 'score', instructions: 'Mood?', criteria: ['calm', 'angry'] },
});

test('a question set survives export -> file text -> parse, and its questions pass server validation', () => {
  const text = JSON.stringify(exportSet('Triage', goodQuestions()));
  const parsed = parseSetFile(text);
  assert.equal(parsed.name, 'Triage');
  assert.deepEqual(parsed.questions, goodQuestions());
  assert.equal(validateRequest({ state: 'x', questions: parsed.questions }).ok, true);
});

test('parseSetFile rejects bad files with a readable message', () => {
  assert.throws(() => parseSetFile('{nope'), /not valid JSON/);
  assert.throws(() => parseSetFile('{"a":1}'), /Jev Studio question set/);
  assert.throws(() => parseSetFile(JSON.stringify({ format: SET_FORMAT, version: 2, questions: goodQuestions() })), /Unsupported/);
  assert.throws(() => parseSetFile(JSON.stringify({ format: SET_FORMAT, version: 1, questions: {} })), /no questions/);
  const bad = goodQuestions();
  bad.mood.criteria = 'nope';
  assert.throws(() => parseSetFile(JSON.stringify(exportSet('x', bad))), /invalid score levels/);
  const unknown = { x: { type: 'rank', instructions: 'q' } };
  assert.throws(() => parseSetFile(JSON.stringify(exportSet('x', unknown))), /unknown type/);
  const tooMany = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'ok' }]));
  assert.throws(() => parseSetFile(JSON.stringify(exportSet('x', tooMany))), /limited to 100/);
});

test('upsertSet replaces by name case-insensitively and keeps the id; removeSet drops one', () => {
  let sets = upsertSet([], 'Triage', goodQuestions(), { now: 1000 });
  assert.equal(sets.length, 1);
  const id = sets[0].id;
  sets = upsertSet(sets, ' triage ', { x: { type: 'noul', instructions: 'changed' } }, { now: 2000 });
  assert.equal(sets.length, 1);
  assert.equal(sets[0].id, id);
  assert.equal(sets[0].savedAt, 2000);
  sets = upsertSet(sets, 'Other', goodQuestions(), { now: 3000 });
  assert.deepEqual(sets.map((s) => s.name), ['Other', 'triage']);
  assert.equal(removeSet(sets, id).length, 1);
  assert.throws(() => upsertSet(sets, '   ', goodQuestions()), /name/);
});

test('a set saved from Batch is edited in Batch; every other set, and imported ones, in Single', () => {
  const fromBatch = upsertSet([], 'Tickets', goodQuestions(), { origin: 'batch', now: 1000 })[0];
  assert.equal(fromBatch.origin, 'batch');
  assert.equal(editPageOf(fromBatch), 'batch');
  assert.equal(EDIT_PAGE_LABEL[editPageOf(fromBatch)], 'Batch');

  for (const origin of [undefined, null, 'custom', 'yesno', 'somewhere else']) {
    const set = upsertSet([], 'Other', goodQuestions(), { origin, now: 1000 })[0];
    assert.equal('origin' in set, false, String(origin));
    assert.equal(editPageOf(set), 'custom');
  }
  assert.equal(editPageOf(undefined), 'custom');

  // overwriting from another page updates where it is edited
  const again = upsertSet([fromBatch], 'tickets', goodQuestions(), { now: 2000 });
  assert.equal(editPageOf(again[0]), 'custom');
  // and the exported file carries no origin: imported sets belong to Single
  assert.equal('origin' in exportSet('Tickets', goodQuestions(), ''), false);
});

/* ---------- export ---------- */

test('resultsToText summarises each answer type', () => {
  const request = {
    state: 'my ticket',
    questions: { urgent: { type: 'noul', instructions: 'x' }, dept: choiceQ(), mood: { type: 'score', instructions: 'm', criteria: ['a', 'b', 'c'] } },
  };
  const response = {
    answers: {
      urgent: { type: 'noul', noul: 0.87 },
      dept: { type: 'choice', choice: 'tech', confidence: 0.6, probabilities: { billing: 0.2, tech: 0.8 } },
      mood: { type: 'score', score: 1.25, confidence: 0.4, legend: {}, probabilities: {} },
    },
  };
  const text = resultsToText({ request, response });
  assert.match(text, /^Input:\nmy ticket\n/);
  assert.match(text, /urgent \(Yes \/ No\): Yes, 87% chance of yes/);
  assert.match(text, /dept \(Choice\): tech \(confidence 60%\)\n {2}tech 80%, billing 20%/);
  assert.match(text, /mood \(Score\): 1.25 on a 0 to 2 scale \(confidence 40%\)/);
});

test('resultsToText and compareRuns cope with runs that had no input', () => {
  const request = { state: null, questions: { urgent: { type: 'noul', instructions: 'x' } } };
  const response = { answers: { urgent: { type: 'noul', noul: 0.9 } } };
  assert.match(resultsToText({ request, response }), /^Input:\n\(none\)\n/);

  const withInput = { request: { ...request, state: 'something' }, response };
  assert.equal(compareRuns({ request, response }, withInput).inputChanged, true);
  assert.equal(compareRuns({ request, response }, { request, response }).inputChanged, false);
});

test('batchCsvRows: columns per question, review flags, composite, and agreement; survives a CSV round trip', () => {
  const questions = { urgent: { type: 'noul', instructions: 'x' }, dept: choiceQ() };
  const ok = (index, urgent, dept, expected = {}) => ({
    index, text: `item ${index}`, status: 'ok', expected,
    response: { answers: { urgent: { type: 'noul', noul: urgent }, dept: { type: 'choice', choice: dept, confidence: 0.9, probabilities: { billing: dept === 'billing' ? 0.9 : 0.1, tech: dept === 'tech' ? 0.9 : 0.1 } } } },
  });
  const run = {
    kind: 'batch', questions, marks: { '1:urgent': false },
    specs: { urgent: { enabled: true, weight: 50, invert: false }, dept: { enabled: false, weight: 50, target: 'billing' } },
    settings: { minCertainty: 0.5, compositeOn: true },
    rows: [
      ok(0, 0.95, 'billing', { urgent: 'yes' }),
      ok(1, 0.55, 'tech'),
      { index: 2, text: '=evil()', status: 'error', error: 'boom', expected: {} },
      { index: 3, text: 'not run yet', status: 'pending', expected: {} },
    ],
  };
  const rows = batchCsvRows(run);
  const [header, ...body] = rows;
  assert.deepEqual(header, ['#', 'item', 'urgent', 'urgent_p_yes', 'dept', 'dept_confidence', 'dept_p_billing', 'dept_p_tech', 'composite_0_100', 'needs_review', 'review_reason', 'urgent_correct', 'dept_correct']);
  assert.deepEqual(body[0].slice(0, 4), [1, 'item 0', 'Yes', 0.95]);
  assert.equal(body[0][8], 95);
  assert.equal(body[0][9], 'no');
  assert.equal(body[0][11], 'yes', 'expected value agrees');
  assert.equal(body[1][9], 'yes');
  assert.match(body[1][10], /urgent: 10% certain/);
  assert.equal(body[1][11], 'no', 'manual mark wins');
  assert.equal(body[2][9], 'yes');
  assert.match(body[2][10], /request failed: boom/);
  assert.equal(body[3][9], '', 'unfinished rows have no review verdict');
  assert.equal(body[2].length, header.length);

  const parsed = parseCsv(toCsv(rows));
  assert.equal(parsed.length, 5);
  assert.equal(parsed[3][1], "'=evil()", 'formula-looking text is neutralised in the file');
  assert.equal(parsed[1][1], 'item 0');
});

test('batchCsvRows omits agreement columns when nothing was labelled, and composite when it is off', () => {
  const questions = { urgent: { type: 'noul', instructions: 'x' } };
  const rows = batchCsvRows({
    kind: 'rank', questions, marks: {}, specs: {}, settings: { minCertainty: 0.5, compositeOn: false },
    rows: [{ index: 0, text: 'c', status: 'ok', expected: {}, response: { answers: { urgent: { type: 'noul', noul: 0.9 } } } }],
  });
  assert.deepEqual(rows[0], ['#', 'candidate', 'urgent', 'urgent_p_yes', 'needs_review', 'review_reason']);
});

/* ---------- rank & usage ---------- */

test('rank questions are valid System One questions and the state names the query and candidate', () => {
  const questions = rankQuestions();
  const state = buildRankState('  how do refunds work ', ' Refunds take 5 days. ');
  assert.equal(state, 'Query: how do refunds work\n\nCandidate: Refunds take 5 days.');
  assert.equal(validateRequest({ state, questions }).ok, true);
  assert.deepEqual(Object.keys(rankSpecs()), Object.keys(questions));
  assert.equal(rankSpecs().relevance.weight + rankSpecs().answers_query.weight, 100);
});

test('token usage accumulates across calls', () => {
  let total = emptyUsage();
  total = addUsage(total, { input_tokens: 1200, output_tokens: 34 });
  total = addUsage(total, { input_tokens: 800, output_tokens: 6 });
  total = addUsage(total, undefined);
  assert.deepEqual(total, { input: 2000, output: 40, calls: 3 });
  assert.equal(formatTokens(total), '2,040 tokens');
});
