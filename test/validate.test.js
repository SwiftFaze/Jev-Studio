import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest } from '../src/validate.js';

const valid = () => ({
  state: 'hello',
  questions: {
    dept: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, tech: 'Bugs' } },
    urgent: { type: 'noul', instructions: 'Urgent?' },
    mood: { type: 'score', instructions: 'Mood?', criteria: ['Calm', 'Angry'] },
  },
});

test('accepts a valid request and defaults the model', () => {
  const res = validateRequest(valid());
  assert.equal(res.ok, true);
  assert.equal(res.value.model, 'jev-latest');
});

test('accepts object state and noul criteria', () => {
  const body = valid();
  body.state = { a: 1 };
  body.questions.urgent.criteria = { true: 'yes', false: 'no' };
  assert.equal(validateRequest(body).ok, true);
});

test('rejects non-object bodies', () => {
  assert.equal(validateRequest(null).ok, false);
  assert.equal(validateRequest([]).ok, false);
});

test('the input (state) is optional: missing, null and blank text all become an empty string', () => {
  for (const state of [undefined, null, '', '   ']) {
    const res = validateRequest({ ...valid(), state });
    assert.equal(res.ok, true, JSON.stringify(state));
    assert.equal(res.value.state, '', JSON.stringify(state));
  }
  const { state: _omitted, ...withoutState } = valid();
  assert.equal(validateRequest(withoutState).value.state, '');
});

test('real input is passed through untouched; only text, objects and arrays are accepted', () => {
  assert.equal(validateRequest({ ...valid(), state: '  keep my spacing ' }).value.state, '  keep my spacing ');
  assert.deepEqual(validateRequest({ ...valid(), state: [1, 2] }).value.state, [1, 2]);
  for (const state of [5, true]) assert.equal(validateRequest({ ...valid(), state }).ok, false, String(state));
});

test('requires at least one question', () => {
  assert.equal(validateRequest({ state: 'x', questions: {} }).ok, false);
  assert.equal(validateRequest({ state: 'x' }).ok, false);
});

test('rejects unknown question types and missing text', () => {
  const body = valid();
  body.questions.bad = { type: 'rank', instructions: 'x' };
  body.questions.urgent.instructions = ' ';
  const res = validateRequest(body);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 2);
});

test('choice needs 2+ options with non-empty keys', () => {
  const one = valid();
  one.questions.dept.criteria = { only: null };
  assert.equal(validateRequest(one).ok, false);

  const blank = valid();
  blank.questions.dept.criteria = { a: null, ' ': null };
  assert.equal(validateRequest(blank).ok, false);

  const badDesc = valid();
  badDesc.questions.dept.criteria = { a: 5, b: null };
  assert.equal(validateRequest(badDesc).ok, false);
});

test('choice allows at most 255 options', () => {
  const body = valid();
  body.questions.dept.criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`k${i}`, null]));
  assert.equal(validateRequest(body).ok, false);
  body.questions.dept.criteria = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`k${i}`, null]));
  assert.equal(validateRequest(body).ok, true);
});

test('score needs 2-10 non-empty levels', () => {
  for (const criteria of [['one'], Array(11).fill('x'), ['a', ''], 'nope']) {
    const body = valid();
    body.questions.mood.criteria = criteria;
    assert.equal(validateRequest(body).ok, false, JSON.stringify(criteria));
  }
  const ten = valid();
  ten.questions.mood.criteria = Array(10).fill('x');
  assert.equal(validateRequest(ten).ok, true);
});

test('noul criteria only allow true/false strings', () => {
  const body = valid();
  body.questions.urgent.criteria = { maybe: 'x' };
  assert.equal(validateRequest(body).ok, false);
  body.questions.urgent.criteria = { true: 1 };
  assert.equal(validateRequest(body).ok, false);
});
