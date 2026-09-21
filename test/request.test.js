import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blankDraft,
  buildQuestions,
  buildRequest,
  draftFromRequest,
  duplicateQuestion,
  migrateDraft,
  newQuestion,
  stateToText,
} from '../public/request.js';
import { TEMPLATES } from '../public/templates.js';
import { validateRequest } from '../src/validate.js';

test('every template round-trips through the editor and passes server validation', () => {
  for (const tpl of TEMPLATES) {
    const rebuilt = buildRequest(draftFromRequest(tpl.request));
    assert.deepEqual(rebuilt.state, tpl.request.state, tpl.name);
    assert.deepEqual(rebuilt.questions, tpl.request.questions, tpl.name);
    assert.equal(validateRequest(rebuilt).ok, true, tpl.name);
  }
});

test('the input is sent as plain text, exactly as typed', () => {
  const draft = blankDraft();
  draft.questions = [newQuestion({ id: 'q', type: 'noul', instructions: 'ok?' })];
  draft.stateText = '{"looks": "like json"} but is just text';
  assert.equal(buildRequest(draft).state, '{"looks": "like json"} but is just text');
});

test('a structured state (older history entry) is restored as readable plain text, not JSON', () => {
  const state = { company: { name: 'Acme', employees: 240 }, tags: ['a', 'b'] };
  const draft = draftFromRequest({ state, questions: { q: { type: 'noul', instructions: 'ok?' } } });
  assert.equal(draft.stateText, ['company.name: Acme', 'company.employees: 240', 'tags.1: a', 'tags.2: b'].join('\n'));
  assert.equal(draft.stateText.includes('{'), false);
  assert.equal('stateMode' in draft, false);
});

test('an empty or blank input is optional and is sent as state: ""', () => {
  const draft = blankDraft();
  draft.questions = [newQuestion({ id: 'q', type: 'noul', instructions: 'Is 7 a prime number?' })];
  for (const text of ['', '   ', '\n\t']) {
    draft.stateText = text;
    const request = buildRequest(draft);
    assert.equal('state' in request, true);
    assert.equal(request.state, '', JSON.stringify(text));
  }
  draft.stateText = '  real input  ';
  assert.equal(buildRequest(draft).state, '  real input  ', 'non-blank input is sent exactly as typed');
});

test('a run that had no input restores as an empty box, not the word "null"', () => {
  const draft = draftFromRequest({ state: null, questions: { q: { type: 'noul', instructions: 'ok?' } } });
  assert.equal(draft.stateText, '');
  assert.equal(stateToText(undefined), '');
});

test('stateToText unwraps the {"text": ...} wrapper the old toggle created', () => {
  assert.equal(stateToText({ text: 'hello there' }), 'hello there');
  assert.equal(stateToText('already text'), 'already text');
  assert.equal(stateToText({ text: 'a', other: 'b' }), 'text: a\nother: b');
});

test('migrateDraft turns a saved JSON-mode draft into a plain text draft', () => {
  const wrapped = migrateDraft({ stateMode: 'json', stateText: '{\n  "text": "my ticket"\n}', questions: [] });
  assert.equal(wrapped.stateText, 'my ticket');
  assert.equal('stateMode' in wrapped, false);

  const record = migrateDraft({ stateMode: 'json', stateText: '{"company": {"name": "Northwind"}, "message": "hi"}', questions: [] });
  assert.equal(record.stateText, 'company.name: Northwind\nmessage: hi');

  const broken = migrateDraft({ stateMode: 'json', stateText: '{not json', questions: [] });
  assert.equal(broken.stateText, '{not json');

  const plain = migrateDraft({ stateMode: 'text', stateText: 'unchanged', questions: [] });
  assert.equal(plain.stateText, 'unchanged');
});

test('duplicateQuestion copies deeply with a fresh uid and an unused id', () => {
  const original = newQuestion({ id: 'billing', options: [{ key: 'a', desc: 'A' }, { key: 'b', desc: '' }] });
  const copy = duplicateQuestion(original, ['billing']);
  assert.equal(copy.id, 'billing_copy');
  assert.notEqual(copy.uid, original.uid);
  assert.deepEqual(copy.options, original.options);
  copy.options[0].key = 'changed';
  assert.equal(original.options[0].key, 'a');
  assert.equal(duplicateQuestion(original, ['billing', 'billing_copy']).id, 'billing_copy2');
});

test('buildQuestions maps editor questions to the API shape', () => {
  const list = [newQuestion({ id: 'c', instructions: ' Pick one ', options: [{ key: 'x', desc: 'X' }, { key: 'y', desc: '' }] })];
  assert.deepEqual(buildQuestions(list), { c: { type: 'choice', instructions: 'Pick one', criteria: { x: 'X', y: null } } });
});

test('rejects duplicate and empty question ids', () => {
  const draft = blankDraft();
  draft.stateText = 'x';
  draft.questions = [newQuestion({ id: 'a', type: 'noul' }), newQuestion({ id: 'a', type: 'noul' })];
  assert.throws(() => buildRequest(draft), /share the id "a"/);
  draft.questions = [newQuestion({ id: ' ', type: 'noul' })];
  assert.throws(() => buildRequest(draft), /needs an id/);
});

test('rejects duplicate choice option keys instead of silently merging them', () => {
  const draft = blankDraft();
  draft.stateText = 'x';
  draft.questions = [
    newQuestion({ id: 'c', options: [{ key: 'a', desc: '' }, { key: 'a', desc: '' }] }),
  ];
  assert.throws(() => buildRequest(draft), /unique/);
});

test('noul criteria are all-or-nothing', () => {
  const draft = blankDraft();
  draft.stateText = 'x';
  draft.questions = [newQuestion({ id: 'n', type: 'noul', instructions: 'q', noul: { yes: 'y', no: '' } })];
  assert.throws(() => buildRequest(draft), /both/);

  draft.questions[0].noul = { yes: '', no: '' };
  assert.equal('criteria' in buildRequest(draft).questions.n, false);
});

test('blank option and level rows are dropped; empty descriptions become null', () => {
  const draft = blankDraft();
  draft.stateText = 'x';
  draft.questions = [
    newQuestion({ id: 'c', instructions: 'q', options: [{ key: 'a', desc: '' }, { key: 'b', desc: 'B' }, { key: '', desc: 'ignored' }] }),
    newQuestion({ id: 's', type: 'score', instructions: 'q', levels: ['low', '', 'high'] }),
  ];
  const { questions } = buildRequest(draft);
  assert.deepEqual(questions.c.criteria, { a: null, b: 'B' });
  assert.deepEqual(questions.s.criteria, ['low', 'high']);
});
