import { h } from '../dom.js';
import { app, PAGE_TYPE, save } from './state.js';
import { duplicateQuestion, newQuestion } from '../request.js';
import { lintQuestion } from '../lib/lint.js';
import { QUESTION_TYPE_LABEL } from '../lib/library.js';

const $ = (selector) => document.querySelector(selector);

// The labels come from the library, so the builder and a saved set's read-only view never name a type differently.
export const TYPE_META = {
  choice: { label: QUESTION_TYPE_LABEL.choice, help: 'Pick exactly one option.', placeholder: 'Which team should handle this?' },
  noul: { label: QUESTION_TYPE_LABEL.noul, help: 'How likely is a statement to be true?', placeholder: 'Does this convey urgency?' },
  score: { label: QUESTION_TYPE_LABEL.score, help: 'Rate along an ordered scale, lowest level first.', placeholder: 'How frustrated is the customer?' },
};

// The builder edits one draft at a time: Single's, Batch's, or one of the typed pages'.
const PAGE_COPY = {
  custom: { title: 'What do you want to know?', hint: 'Each question is one narrow judgment. Jev answers all of them in a single call.' },
  yesno: { title: 'Your yes / no questions', hint: 'Each one is a statement Jev rates as true or false. You get the probability of yes.' },
  score: { title: 'Your score questions', hint: 'Each one rates the input along an ordered scale. Describe every level with a concrete situation.' },
  choice: { title: 'Your choice questions', hint: 'Each one makes Jev pick exactly one option and shows how probability is spread across all of them.' },
  batch: { title: 'Questions for every item', hint: 'Each item is judged against these questions, one request per item. They are Batch\'s own and separate from the Single page.' },
};

let page = 'custom';
const draftNow = () => app.drafts[page];
const lockedNow = () => PAGE_TYPE[page] ?? null;
const saveNow = () => save.page(page);

const cardFor = (q) => document.querySelector(`[data-uid="${q.uid}"]`);
const lintItems = (q) => lintQuestion(q).map((note) => h('li', { class: `lint-${note.level}` }, note.message));

/** Re-run the advice for one question without rebuilding the card (which would steal focus mid-typing). */
function relint(q) {
  cardFor(q)?.querySelector('.lint')?.replaceChildren(...lintItems(q));
}

function touch(q) {
  saveNow();
  relint(q);
}

const textInput = (q, value, placeholder, label, onInput, cls = '') =>
  h('input', {
    class: `text ${cls}`.trim(),
    value,
    placeholder,
    'aria-label': label,
    oninput: (e) => {
      onInput(e.target.value);
      touch(q);
    },
  });

const iconButton = (label, glyph, onclick, disabled = false) =>
  h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, disabled, onclick }, glyph);

const addButton = (label, onclick) => h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick }, label);

function edit(mutate, focusSelector, q) {
  mutate();
  saveNow();
  renderBuilder();
  if (focusSelector) cardFor(q)?.querySelector(focusSelector)?.focus();
}

function optionsEditor(q) {
  const rows = q.options.map((o, i) =>
    h(
      'div',
      { class: 'row row-option' },
      textInput(q, o.key, 'key', 'Option key', (v) => (o.key = v), 'mono'),
      textInput(q, o.desc, 'What this option means (optional)', 'Option description', (v) => (o.desc = v)),
      iconButton('Remove option', '✕', () => edit(() => q.options.splice(i, 1))),
    ),
  );
  return h(
    'div',
    { class: 'criteria' },
    h('span', { class: 'field-label' }, 'Options'),
    h('div', { class: 'rows' }, rows),
    addButton('+ Add option', () => edit(() => q.options.push({ key: '', desc: '' }), '.row:last-child input', q)),
  );
}

function noulEditor(q) {
  return h(
    'div',
    { class: 'criteria' },
    h('span', { class: 'field-label' }, 'What the answers mean (optional, but sharper results)'),
    h('div', { class: 'rows' }, [
      h('div', { class: 'row row-noul' }, h('span', { class: 'tag tag-yes' }, 'Yes means'), textInput(q, q.noul.yes, 'e.g. Explicitly time-sensitive', 'Yes means', (v) => (q.noul.yes = v))),
      h('div', { class: 'row row-noul' }, h('span', { class: 'tag tag-no' }, 'No means'), textInput(q, q.noul.no, 'e.g. No urgency expressed', 'No means', (v) => (q.noul.no = v))),
    ]),
  );
}

function scoreEditor(q) {
  const swap = (i, j) => edit(() => ([q.levels[i], q.levels[j]] = [q.levels[j], q.levels[i]]));
  const rows = q.levels.map((level, i) =>
    h(
      'div',
      { class: 'row row-level' },
      h('span', { class: 'level-index' }, String(i)),
      textInput(q, level, 'Describe a concrete situation for this level', `Level ${i}`, (v) => (q.levels[i] = v)),
      iconButton('Move up', '↑', () => swap(i, i - 1), i === 0),
      iconButton('Move down', '↓', () => swap(i, i + 1), i === q.levels.length - 1),
      iconButton('Remove level', '✕', () => edit(() => q.levels.splice(i, 1))),
    ),
  );
  return h(
    'div',
    { class: 'criteria' },
    h('span', { class: 'field-label' }, 'Levels (0 is lowest)'),
    h('div', { class: 'rows' }, rows),
    addButton('+ Add level', () => edit(() => q.levels.push(''), '.row:last-child input', q)),
  );
}

function typeControl(q) {
  const locked = lockedNow();
  // A dedicated page is for one type, so there is nothing to switch.
  if (locked) return h('span', { class: 'tag tag-type' }, TYPE_META[locked].label);
  return h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Question type' },
    Object.entries(TYPE_META).map(([type, m]) =>
      h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(q.type === type), onclick: () => edit(() => (q.type = type)) }, m.label),
    ),
  );
}

function questionCard(q) {
  const meta = TYPE_META[q.type];
  const editor = { choice: optionsEditor, noul: noulEditor, score: scoreEditor }[q.type];

  return h(
    'article',
    { class: 'q-card', 'data-uid': q.uid },
    h(
      'div',
      { class: 'q-head' },
      h('input', {
        class: 'text mono q-id',
        value: q.id,
        placeholder: 'question_id',
        'aria-label': 'Question id',
        oninput: (e) => {
          q.id = e.target.value;
          saveNow();
        },
      }),
      typeControl(q),
      iconButton(`Duplicate question ${q.id}`, '⧉', () => {
        const questions = draftNow().questions;
        const copy = duplicateQuestion(q, questions.map((x) => x.id.trim()));
        edit(() => questions.splice(questions.indexOf(q) + 1, 0, copy));
      }),
      iconButton(`Remove question ${q.id}`, '✕', () => edit(() => (draftNow().questions = draftNow().questions.filter((x) => x !== q)))),
    ),
    h('p', { class: 'hint' }, meta.help),
    h('textarea', {
      class: 'text',
      rows: 2,
      value: q.instructions,
      placeholder: meta.placeholder,
      'aria-label': 'Question text',
      oninput: (e) => {
        q.instructions = e.target.value;
        touch(q);
      },
    }),
    editor(q),
    h('ul', { class: 'lint', 'aria-label': 'Suggestions for this question' }, lintItems(q)),
  );
}

export function renderBuilder() {
  const root = $('#questions');
  const questions = draftNow().questions;
  root.replaceChildren(...questions.map(questionCard));
  if (questions.length === 0) root.append(h('p', { class: 'muted' }, 'No questions yet. Add one below.'));
}

/** Point the builder at another page's questions. */
export function setBuilderPage(next) {
  page = next;
  $('#builder-title').textContent = `2. ${PAGE_COPY[page].title}`;
  $('#builder-hint').textContent = PAGE_COPY[page].hint;
  renderBuilder();
}

export function initBuilder() {
  $('#add-question').addEventListener('click', () => {
    const questions = draftNow().questions;
    const taken = new Set(questions.map((q) => q.id.trim()));
    let n = questions.length + 1;
    while (taken.has(`question_${n}`)) n++;
    questions.push(newQuestion({ id: `question_${n}`, type: lockedNow() ?? 'choice' }));
    saveNow();
    renderBuilder();
    document.querySelector('#questions .q-card:last-child textarea')?.focus();
  });
  setBuilderPage(page);
}
