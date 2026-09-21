import test from 'node:test';
import assert from 'node:assert/strict';
import { BATCH_EXAMPLES, RANK_EXAMPLES, STEAM_EXAMPLES, TEMPLATES, TYPE_EXAMPLES } from '../public/templates.js';
import { emptyTally, parseSteamApp } from '../public/lib/steam.js';
import { applyExpected, MAX_ITEMS, parseItems } from '../public/lib/batch.js';
import { buildRankState } from '../public/lib/rank.js';
import { blankDraft, buildRequest, draftFromRequest } from '../public/request.js';
import { lintQuestion } from '../public/lib/lint.js';
import { validateRequest } from '../src/validate.js';
import { app, currentDraft, currentPage, hasQuestionWork, isSetMode, isSteamSavedMode, lockedType, MODES, PAGES, PAGE_TYPE, save, setIdOf, steamSavedIdOf } from '../public/ui/state.js';

test('there is a page for each question type, and each has examples', () => {
  assert.deepEqual(PAGES, ['custom', 'yesno', 'score', 'choice']);
  assert.deepEqual(PAGE_TYPE, { yesno: 'noul', score: 'score', choice: 'choice' });
  for (const page of Object.keys(PAGE_TYPE)) assert.ok(TYPE_EXAMPLES[page].length >= 2, `${page} has examples`);
  assert.deepEqual(MODES, ['custom', 'yesno', 'score', 'choice', 'batch', 'rank', 'steam', 'compare']);
});

test('every example on a typed page uses only that page\'s type, is valid, and gets no lint warnings', () => {
  for (const [page, examples] of Object.entries(TYPE_EXAMPLES)) {
    for (const example of examples) {
      const label = `${page}: ${example.name}`;
      const draft = draftFromRequest(example.request);
      assert.ok(draft.questions.length > 0, label);
      for (const q of draft.questions) {
        assert.equal(q.type, PAGE_TYPE[page], `${label} / ${q.id}`);
        assert.deepEqual(lintQuestion(q).filter((n) => n.level === 'warn'), [], `${label} / ${q.id}`);
      }
      const request = buildRequest(draft);
      assert.equal(validateRequest(request).ok, true, label);
      assert.deepEqual(request.questions, example.request.questions, `${label} survives the editor round trip`);
    }
  }
});

test('the no-input Yes / No example really has no input and sends state: null', () => {
  const example = TYPE_EXAMPLES.yesno.find((e) => /no input/i.test(e.name));
  assert.ok(example);
  const request = buildRequest(draftFromRequest(example.request));
  assert.equal(request.state, null);
  assert.equal(validateRequest(request).value.state, null);
});

test('example names are unique per page (the menu is keyed by index, so duplicates would confuse people)', () => {
  for (const [page, examples] of Object.entries({ custom: TEMPLATES, ...TYPE_EXAMPLES })) {
    const names = examples.map((e) => e.name);
    assert.equal(new Set(names).size, names.length, page);
  }
});

test('blankDraft creates one empty question of the requested type', () => {
  assert.equal(blankDraft().questions[0].type, 'choice');
  assert.equal(blankDraft('noul').questions[0].type, 'noul');
  assert.equal(blankDraft('score').questions.length, 1);
  assert.equal(blankDraft('score').stateText, '');
});

test('each typed page starts from its own first example with the right type; pages are independent', () => {
  for (const [page, type] of Object.entries(PAGE_TYPE)) {
    const draft = app.drafts[page];
    assert.ok(draft.questions.length > 0);
    assert.ok(draft.questions.every((q) => q.type === type), page);
    assert.equal(draft.stateText, TYPE_EXAMPLES[page][0].request.state);
  }
  const before = app.drafts.score.stateText;
  app.drafts.yesno.stateText = 'changed on the Yes / No page';
  assert.equal(app.drafts.score.stateText, before);
  assert.notEqual(app.drafts.custom, app.drafts.yesno);
});

test('app.draft is the Custom page draft, in both directions (old code relies on it)', () => {
  assert.equal(app.draft, app.drafts.custom);
  const replacement = blankDraft();
  const original = app.drafts.custom;
  app.draft = replacement;
  assert.equal(app.drafts.custom, replacement);
  app.draft = original;
});

test('the question builder follows the page: typed pages lock the type, Custom and Batch do not; Batch has its own', () => {
  const at = (mode) => {
    app.mode = mode;
    return { page: currentPage(), draft: currentDraft(), locked: lockedType() };
  };
  assert.equal(at('custom').locked, null);
  assert.equal(at('custom').draft, app.drafts.custom);

  for (const [page, type] of Object.entries(PAGE_TYPE)) {
    const state = at(page);
    assert.equal(state.page, page);
    assert.equal(state.locked, type);
    assert.equal(state.draft, app.drafts[page]);
  }

  const batch = at('batch');
  assert.equal(batch.page, 'batch');
  assert.equal(batch.locked, null);
  assert.equal(batch.draft, app.drafts.batch);
  assert.notEqual(batch.draft, app.drafts.custom);
  app.mode = 'custom';
});

test('Batch starts from a copy of Single\'s questions, then the two are independent', () => {
  const single = app.drafts.custom.questions;
  const batch = app.drafts.batch.questions;
  assert.equal(batch.length, single.length, 'a first visit starts from what Single had');
  const singleUids = new Set(single.map((q) => q.uid));
  assert.ok(batch.every((q) => !singleUids.has(q.uid)), 'copies get their own uids, so rows never clash');

  const before = single[0].instructions;
  batch[0].instructions = 'changed on the Batch page';
  assert.equal(single[0].instructions, before, 'editing Batch leaves Single alone');
  app.drafts.batch = { stateText: '', questions: blankDraft().questions };
  assert.equal(hasQuestionWork(app.drafts.custom), true, 'and clearing Batch leaves Single\'s questions');
  assert.equal(hasQuestionWork(app.drafts.batch), false);
});

test('hasQuestionWork looks at the given draft, else the current page', () => {
  assert.equal(hasQuestionWork(blankDraft()), false);
  assert.equal(hasQuestionWork(app.drafts.yesno), true);
  app.mode = 'yesno';
  assert.equal(hasQuestionWork(), true);
  app.mode = 'custom';
});

test('saving never throws when browser storage is unavailable (as in Node, and in blocked-storage browsers)', () => {
  assert.doesNotThrow(() => {
    save.page('custom');
    save.page('yesno');
    save.history();
    save.sets();
    save.mode();
    save.setInputs();
    save.setsMenu();
    save.steamMenu();
  });
});

test('a saved question set is a page of its own, addressed as set:<id>', () => {
  assert.equal(isSetMode('set:s1a2b'), true);
  assert.equal(setIdOf('set:s1a2b'), 's1a2b');
  for (const notASet of ['custom', 'batch', 'compare', 'settings', '', undefined, null]) assert.equal(isSetMode(notASet), false, String(notASet));
  assert.equal(MODES.some(isSetMode), false, 'set pages are dynamic, never part of the fixed list');
  assert.deepEqual(app.setInputs, {}, 'no context is remembered for any set until you paste one');
  assert.equal(app.setsMenuOpen, true, 'the Question sets submenu starts open');
  assert.equal(app.steamMenuOpen, true, 'and so do the saved analyses under Steam reviews');
});

test('with a set page open, the question builder points at Single (a set has no visible questions)', () => {
  app.mode = 'set:whatever';
  assert.equal(currentPage(), 'custom');
  assert.equal(currentDraft(), app.drafts.custom);
  assert.equal(lockedType(), null);
  app.mode = 'custom';
});

test('rank examples: a query plus candidates that fit Rank, and the text round-trips through the candidates box', () => {
  assert.ok(RANK_EXAMPLES.length >= 1);
  for (const example of RANK_EXAMPLES) {
    assert.ok(example.name.trim() && example.query.trim(), example.name);
    assert.ok(example.candidates.length >= 2 && example.candidates.length <= MAX_ITEMS, example.name);
    assert.equal(new Set(example.candidates).size, example.candidates.length, 'no duplicate candidates');
    assert.ok(example.candidates.every((c) => c.trim() && c === c.trim()), 'no blank or padded candidates');

    const shown = example.candidates.join('\n'); // what the candidates box shows
    const { items, truncated } = parseItems(shown);
    assert.equal(truncated, false);
    assert.deepEqual(items.map((i) => i.text), example.candidates, 'nothing is lost or reordered by the box');
    assert.equal(buildRankState(example.query, example.candidates[0]), `Query: ${example.query}\n\nCandidate: ${example.candidates[0]}`);
  }
});

test('the weapon example: the corrected query and all 88 candidates, in the order given', () => {
  const example = RANK_EXAMPLES.find((e) => /weapon/i.test(e.name));
  assert.ok(example);
  assert.equal(example.query, 'Could this be used as an effective weapon?');
  assert.equal(example.candidates.length, 88);
  assert.deepEqual([example.candidates[0], example.candidates[1], example.candidates.at(-2), example.candidates.at(-1)], ['Hot Sauce', 'Grilled Tart', 'Gourmet Hot Sauce', 'Hot coffee']);
});

test('batch examples: valid questions, one-line unique items, and usable expected answers', () => {
  assert.ok(BATCH_EXAMPLES.length >= 2);
  for (const example of BATCH_EXAMPLES) {
    assert.equal(validateRequest({ state: 'x', questions: example.questions }).ok, true, example.name);
    assert.ok(example.items.length >= 5 && example.items.length <= MAX_ITEMS, example.name);

    const texts = example.items.map((i) => i.text);
    assert.equal(new Set(texts).size, texts.length, 'items are unique, because expected answers are matched to lines by their text');
    assert.ok(texts.every((t) => t !== '' && t === t.trim() && !t.includes('\n')), 'one clean line per item');

    for (const item of example.items) {
      for (const [id, value] of Object.entries(item.expected ?? {})) {
        const q = example.questions[id];
        assert.ok(q, `${example.name}: an expected answer for an unknown question "${id}"`);
        if (q.type === 'noul') assert.match(value, /^(yes|no)$/, `${id}: ${value}`);
        if (q.type === 'choice') assert.ok(Object.keys(q.criteria).includes(value), `${id}: "${value}" is not an option`);
        if (q.type === 'score') assert.ok(Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) < q.criteria.length, `${id}: ${value}`);
      }
    }

    // what the items box shows must give the same items, with their expected answers reattached, when it is read back
    const { items } = parseItems(texts.join('\n'));
    assert.deepEqual(items.map((i) => i.text), texts);
    assert.deepEqual(applyExpected(items, example.items).map((i) => i.expected), example.items.map((i) => i.expected ?? {}));
  }
});

test('the first batch example carries expected answers for every item; the second has none', () => {
  assert.equal(BATCH_EXAMPLES[0].items.length, 14);
  assert.ok(BATCH_EXAMPLES[0].items.every((i) => i.expected && Object.keys(i.expected).length >= 2));
  assert.ok(BATCH_EXAMPLES[1].items.every((i) => !i.expected));
});

test('steam examples: unique names, and every link is a Steam store link that names its game', () => {
  assert.ok(STEAM_EXAMPLES.length >= 2);
  assert.equal(new Set(STEAM_EXAMPLES.map((e) => e.name)).size, STEAM_EXAMPLES.length, 'the menu is keyed by index, so duplicates would confuse people');
  for (const example of STEAM_EXAMPLES) {
    const game = parseSteamApp(example.url);
    assert.ok(game, example.name);
    assert.ok(game.name, `${example.name}: the link carries the game's name`);
  }
  assert.equal(parseSteamApp(STEAM_EXAMPLES[0].url).appId, '548430');
});

test('the Steam page saves like the others, and starts with nothing read, at the start of the reviews', () => {
  assert.doesNotThrow(() => save.steam());
  const s = app.steam;
  assert.equal(s.url, '');
  assert.deepEqual([s.count, s.sort], [100, 'recent'], 'the batch size and the sort');
  assert.equal('language' in s, false, 'reviews are always read in every language, so there is nothing to choose');
  assert.deepEqual([s.batches, s.cursor, s.exhausted, s.key, s.run], [0, '*', false, null, null]);
  assert.deepEqual(s.tally, emptyTally());
  assert.equal(s.batchOpen, true, 'the batch card starts open, because the overview is in it');
  assert.equal(s.tableOpen, false, 'the table starts closed');
  assert.equal('reviews' in s, false, 'loaded reviews are not kept as a list: only the batch on screen and counts for the rest');
});

test('a saved Steam analysis is a page of its own, addressed as steamsaved:<id>, and starts with none saved', () => {
  assert.equal(isSteamSavedMode('steamsaved:a1b2'), true);
  assert.equal(steamSavedIdOf('steamsaved:a1b2'), 'a1b2');
  for (const notSaved of ['steam', 'set:x', 'custom', '', undefined, null]) assert.equal(isSteamSavedMode(notSaved), false, String(notSaved));
  assert.equal(isSetMode('steamsaved:a1b2'), false, 'and it is not a question set');
  assert.equal(MODES.some(isSteamSavedMode), false, 'saved pages are dynamic, never part of the fixed list');
  assert.deepEqual(app.steamSaved, []);
  assert.equal(app.steam.savedId, null);
  assert.equal(save.steamSaved(), false, 'saving reports false when there is no browser storage, rather than throwing');
});
