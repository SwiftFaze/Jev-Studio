import { h } from '../dom.js';
import { app, currentDraft, currentPage, save } from './state.js';
import { buildQuestions } from '../request.js';
import { MAX_DESCRIPTION, saveProblems, upsertSet } from '../lib/library.js';

const $ = (selector) => document.querySelector(selector);

let hooks = { onSetsChanged: () => {} };
let flashTimer = null;

export function initSaveSet(options) {
  hooks = { ...hooks, ...options };
}

const findByName = (name) => app.sets.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A short confirmation in the bottom bar that fades on its own. */
export function flash(message) {
  const el = $('#dock-flash');
  el.textContent = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.textContent = ''), 4500);
}

/**
 * The Save button in the bottom bar: save the questions on the page as a question set, or overwrite one.
 * It asks for a Title (the set's name in the menu) and a Description (what to paste into the set's context box).
 * Nothing is overwritten by accident: when the title matches an existing set the dialog says so and the button changes
 * from Save to Overwrite. Sets that would fail the moment they run are refused, with the reason.
 */
export function openSaveSet() {
  const dialog = $('#save-dialog');
  const body = $('#save-body');
  const draft = currentDraft();

  let questions = null;
  let problems = [];
  try {
    questions = buildQuestions(draft.questions);
    problems = saveProblems(questions);
  } catch (err) {
    problems = [err.message];
  }
  const count = questions ? Object.keys(questions).length : 0;
  // Questions that came from a set (Edit in Single or Batch) or were saved before are linked to it, so its details are prefilled.
  const linked = app.sets.find((s) => s.id === draft.setId);

  const nameInput = h('input', {
    class: 'text',
    id: 'save-name',
    maxLength: 80,
    value: linked?.name ?? '',
    placeholder: 'For example: Article bias checker',
    'aria-label': 'Title',
  });
  const descriptionInput = h('textarea', {
    class: 'text',
    id: 'save-description',
    rows: 3,
    maxLength: MAX_DESCRIPTION,
    value: linked?.description ?? '',
    placeholder: 'What should be pasted into the context box? For example: Paste the contents of your article and they will be tested for bias.',
    'aria-label': 'Description',
  });
  const note = h('p', { id: 'save-note', class: 'hint', role: 'status' });
  const confirmBtn = h('button', { type: 'button', id: 'save-confirm', class: 'btn btn-primary btn-sm', onclick: doSave });

  // Typing the title of a set that already exists brings in its description, unless you have started writing your own.
  let descriptionEdited = false;
  descriptionInput.addEventListener('input', () => (descriptionEdited = true));
  let lastFilledFrom = null;

  function update() {
    const name = nameInput.value.trim();
    const existing = name ? findByName(name) : null;
    if (existing && !descriptionEdited && lastFilledFrom !== existing.id) {
      descriptionInput.value = existing.description ?? '';
      lastFilledFrom = existing.id;
    }
    confirmBtn.textContent = existing ? 'Overwrite' : 'Save';
    confirmBtn.disabled = problems.length > 0 || !name;
    note.className = existing ? 'notice' : 'hint';
    if (existing) note.textContent = `A set titled "${existing.name}" already exists (${plural(Object.keys(existing.questions).length, 'question')}). Overwrite replaces its questions and description with these ${count}.`;
    else note.textContent = name && problems.length === 0 ? `Saves the ${plural(count, 'question')} on this page as a new set.` : '';
  }

  function doSave() {
    if (confirmBtn.disabled) return;
    const name = nameInput.value.trim();
    const existed = Boolean(findByName(name));
    app.sets = upsertSet(app.sets, name, questions, { description: descriptionInput.value, origin: currentPage() });
    save.sets();
    const saved = findByName(name);
    draft.setId = saved.id;
    save.page(currentPage());
    hooks.onSetsChanged();
    dialog.close();
    flash(existed ? `Overwrote "${saved.name}".` : `Saved "${saved.name}". It is under Question sets in the menu.`);
  }

  nameInput.addEventListener('input', update);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSave();
    }
  });

  body.replaceChildren(
    ...[
      h('p', { class: 'hint' }, `Saves the questions on this page (${plural(count, 'question')}) as a question set. Each set becomes a page in the side menu, with a context box for whatever you paste.`),
      problems.length > 0 && h('div', { class: 'error', role: 'alert' }, h('strong', {}, 'These questions cannot be saved yet:'), h('ul', {}, problems.map((p) => h('li', {}, p)))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Title'), nameInput),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Description (optional): shown on the set\'s page, above the context box'), descriptionInput),
      note,
      h('div', { class: 'dialog-actions' }, confirmBtn, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dialog.close() }, 'Cancel')),
    ].filter(Boolean),
  );

  update();
  dialog.showModal();
  nameInput.focus();
  nameInput.select();
}
