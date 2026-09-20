import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestions, newQuestion, questionsFromApi } from '../public/request.js';
import { exportSet, MAX_DESCRIPTION, parseSetFile, saveProblems, upsertSet } from '../public/lib/library.js';
import { BATCH_EXAMPLES, TEMPLATES, TYPE_EXAMPLES } from '../public/templates.js';
import { validateRequest } from '../src/validate.js';

const good = () => ({
  a: { type: 'noul', instructions: 'Is this urgent today?' },
  b: { type: 'choice', instructions: 'Which team handles it?', criteria: { billing: null, tech: null } },
  c: { type: 'score', instructions: 'How angry is the writer?', criteria: ['calm', 'angry'] },
});

/* ---------- what may be saved ---------- */

test('saveProblems: a valid set has none', () => {
  assert.deepEqual(saveProblems(good()), []);
});

test('saveProblems: catches what would fail the moment the set runs (the API limits)', () => {
  assert.match(saveProblems({})[0], /at least one question/);

  const blankText = good();
  blankText.a.instructions = '  ';
  assert.match(saveProblems(blankText).join(' '), /no question text/);

  const oneOption = good();
  oneOption.b.criteria = { only: null };
  assert.match(saveProblems(oneOption).join(' '), /at least 2 options/);

  const oneLevel = good();
  oneLevel.c.criteria = ['only'];
  assert.match(saveProblems(oneLevel).join(' '), /2 to 10 score levels/);

  const tooMany = good();
  tooMany.c.criteria = Array(11).fill('level');
  assert.match(saveProblems(tooMany).join(' '), /2 to 10 score levels/);
});

test('saveProblems reports every broken question, not just the first', () => {
  const broken = good();
  broken.a.instructions = '';
  broken.b.criteria = { only: null };
  assert.equal(saveProblems(broken).length, 2);
});

test('saveProblems agrees with the server validator: what it accepts, a run accepts', () => {
  const sets = [
    good(),
    ...TEMPLATES.map((t) => t.request.questions),
    ...Object.values(TYPE_EXAMPLES).flat().map((e) => e.request.questions),
    ...BATCH_EXAMPLES.map((e) => e.questions),
  ];
  for (const questions of sets) {
    assert.deepEqual(saveProblems(questions), []);
    assert.equal(validateRequest({ state: 'x', questions }).ok, true);
  }
});

test('questions built from the editor pass saveProblems, and a blank editor card does not', () => {
  assert.deepEqual(saveProblems(buildQuestions(questionsFromApi(good()))), []);
  assert.ok(saveProblems(buildQuestions([newQuestion({ id: 'question_1' })])).length > 0, 'an empty question card cannot be saved as a set');
});

/* ---------- the description: what to paste into the set's context box ---------- */

const DESCRIPTION = 'Paste the contents of your article and they will be tested for bias';

test('a saved set keeps its title and its description', () => {
  const sets = upsertSet([], 'Article bias checker', good(), { description: DESCRIPTION, now: 1000 });
  assert.equal(sets[0].name, 'Article bias checker');
  assert.equal(sets[0].description, DESCRIPTION);
});

test('a description is optional and defaults to empty', () => {
  assert.equal(upsertSet([], 'No description', good())[0].description, '');
});

test('the description is trimmed and capped', () => {
  assert.equal(upsertSet([], 'x', good(), { description: `  ${DESCRIPTION}  ` })[0].description, DESCRIPTION);
  assert.equal(upsertSet([], 'x', good(), { description: 'a'.repeat(MAX_DESCRIPTION + 50) })[0].description.length, MAX_DESCRIPTION);
});

test('overwriting a set replaces its description too, and keeps its id', () => {
  let sets = upsertSet([], 'Checker', good(), { description: 'old text', now: 1000 });
  const id = sets[0].id;
  sets = upsertSet(sets, ' checker ', good(), { description: 'new text', now: 2000 });
  assert.equal(sets.length, 1);
  assert.equal(sets[0].id, id);
  assert.equal(sets[0].description, 'new text');
  sets = upsertSet(sets, 'Checker', good(), { now: 3000 });
  assert.equal(sets[0].description, '', 'saving with no description clears it rather than keeping the old one');
});

test('the description survives export -> file -> import', () => {
  const file = JSON.stringify(exportSet('Article bias checker', good(), DESCRIPTION));
  assert.equal(JSON.parse(file).description, DESCRIPTION);
  const parsed = parseSetFile(file);
  assert.equal(parsed.name, 'Article bias checker');
  assert.equal(parsed.description, DESCRIPTION);
  assert.deepEqual(parsed.questions, good());
});

test('a set without a description exports a file with no description key, and older files still import', () => {
  const file = exportSet('Plain', good());
  assert.equal('description' in file, false);
  assert.equal('description' in exportSet('Blank', good(), '   '), false);
  assert.equal(parseSetFile(JSON.stringify(file)).description, '');
});

test('importing tolerates a bad description: non-text is ignored, long text is cut', () => {
  const base = { ...exportSet('x', good()) };
  assert.equal(parseSetFile(JSON.stringify({ ...base, description: 42 })).description, '');
  assert.equal(parseSetFile(JSON.stringify({ ...base, description: 'b'.repeat(MAX_DESCRIPTION + 10) })).description.length, MAX_DESCRIPTION);
});
