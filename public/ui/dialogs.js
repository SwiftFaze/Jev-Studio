import { h } from '../dom.js';
import { app, hasQuestionWork, save } from './state.js';
import { EDIT_PAGE_LABEL, editPageOf, exportSet, parseSetFile, removeSet, upsertSet } from '../lib/library.js';
import { analyzeCsv, guessHeader, itemsFromCsv } from '../lib/batch.js';
import { downloadText } from './download.js';

const $ = (selector) => document.querySelector(selector);

/* ---------- History ---------- */

const stateText = (entry) => {
  const s = entry.request.state;
  return s == null ? '' : typeof s === 'string' ? s : JSON.stringify(s);
};

function renderHistory(restoreRun) {
  const list = $('#history-list');
  const term = $('#history-search').value.trim().toLowerCase();
  const matches = app.history.filter((entry) => {
    if (!term) return true;
    const questions = Object.entries(entry.request.questions).map(([id, q]) => `${id} ${typeof q.instructions === 'string' ? q.instructions : ''}`);
    return [stateText(entry), ...questions].join('\n').toLowerCase().includes(term);
  });

  if (app.history.length === 0) return list.replaceChildren(h('p', { class: 'muted' }, 'No runs yet.'));
  if (matches.length === 0) return list.replaceChildren(h('p', { class: 'muted' }, 'Nothing matches that search.'));

  list.replaceChildren(
    ...matches.map((entry) => {
      const text = stateText(entry) || '(no input)';
      const count = Object.keys(entry.request.questions).length;
      return h(
        'button',
        {
          type: 'button',
          class: 'history-item',
          onclick: () => {
            restoreRun(entry);
            $('#history-dialog').close();
          },
        },
        h('span', { class: 'history-state' }, text.length > 90 ? `${text.slice(0, 90)}…` : text),
        h('span', { class: 'muted small' }, `${new Date(entry.ts).toLocaleString()} · ${count} question${count === 1 ? '' : 's'}${entry.mock ? ' · mock' : ''}`),
      );
    }),
  );
}

/* ---------- Question sets ---------- */

function renderSets(hooks, message = '', isError = false) {
  const dialog = $('#sets-dialog');
  const body = $('#sets-body');
  const again = (text, failed = false) => renderSets(hooks, text, failed);

  const fileInput = h('input', {
    type: 'file',
    id: 'set-file',
    accept: '.json,application/json',
    hidden: true,
    onchange: async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        if (file.size > 1_000_000) throw new Error('That file is too large (1 MB max).');
        const parsed = parseSetFile(await file.text());
        app.sets = upsertSet(app.sets, parsed.name, parsed.questions, { description: parsed.description });
        save.sets();
        hooks.onSetsChanged();
        again(`Imported "${parsed.name}". It is under Question sets in the side menu now.`);
      } catch (err) {
        again(err.message, true);
      }
    },
  });

  const rows = app.sets.map((set) => {
    const count = Object.keys(set.questions).length;
    return h(
      'div',
      { class: 'set-row' },
      h('div', { class: 'set-name' }, h('strong', {}, set.name), set.description && h('span', { class: 'set-desc small' }, set.description), h('span', { class: 'muted small' }, `${count} question${count === 1 ? '' : 's'}`)),
      h('button', {
        type: 'button',
        class: 'btn btn-sm',
        onclick: () => {
          dialog.close();
          hooks.openSet(set.id);
        },
      }, 'Open'),
      h('button', {
        type: 'button',
        class: 'btn btn-sm',
        title: `Put this set's questions into the ${EDIT_PAGE_LABEL[editPageOf(set)]} page, where you can see and change them`,
        onclick: () => {
          const page = editPageOf(set);
          if (hasQuestionWork(app.drafts[page]) && !confirm(`Replace the questions on the ${EDIT_PAGE_LABEL[page]} page with "${set.name}"?`)) return;
          hooks.editSet(set.id);
          dialog.close();
        },
      }, `Edit in ${EDIT_PAGE_LABEL[editPageOf(set)]}`),
      h('button', {
        type: 'button',
        class: 'btn btn-sm',
        onclick: () => downloadText(`${set.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'questions'}.jev-questions.json`, JSON.stringify(exportSet(set.name, set.questions, set.description), null, 2), 'application/json'),
      }, 'Export'),
      h('button', {
        type: 'button',
        class: 'btn btn-sm',
        onclick: () => {
          if (!confirm(`Delete "${set.name}"?`)) return;
          app.sets = removeSet(app.sets, set.id);
          delete app.setInputs[set.id];
          save.sets();
          save.setInputs();
          hooks.onSetsChanged();
          again('');
        },
      }, 'Delete'),
    );
  });

  body.replaceChildren(
    ...[
      h('p', { class: 'hint' }, 'Each saved set appears under Question sets in the side menu and opens as its own page: paste some context, ask, read the answers. Its questions are fixed there. Use Edit to see or change them: sets saved from Batch open in Batch, all others in Single. To save a new set, use the Save button in the bottom bar.'),
      message && h('p', { class: isError ? 'error' : 'notice-ok', role: 'status' }, message),
      app.sets.length === 0 ? h('p', { class: 'muted' }, 'No saved sets yet.') : h('div', { class: 'set-list' }, rows),
      h('div', {}, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => fileInput.click() }, 'Import from file…'), fileInput),
    ].filter(Boolean),
  );
}

/* ---------- CSV import ---------- */

export function openCsvDialog(fileName, rows, { questionIds, onImport }) {
  const dialog = $('#csv-dialog');
  const body = $('#csv-body');
  let hasHeader = guessHeader(rows);
  let chosenColumn = null;

  function render() {
    const info = analyzeCsv(rows, questionIds, hasHeader);
    const textIndex = chosenColumn !== null && chosenColumn < info.headers.length ? chosenColumn : info.textIndex;
    const { items, truncated, total } = itemsFromCsv(rows, { hasHeader, textIndex, expected: info.expected });

    const column = h(
      'select',
      { id: 'csv-column', 'aria-label': 'Column that holds the text', onchange: (e) => { chosenColumn = Number(e.target.value); render(); } },
      info.headers.map((name, i) => h('option', { value: String(i) }, name || `Column ${i + 1}`)),
    );
    column.value = String(textIndex);

    const expectedList = Object.entries(info.expected);
    body.replaceChildren(
      h('p', { class: 'hint' }, `${fileName}: ${info.rowCount} row${info.rowCount === 1 ? '' : 's'}, ${info.headers.length} column${info.headers.length === 1 ? '' : 's'}. Line breaks inside a cell are joined with spaces, because each item is one line.`),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'csv-header', checked: hasHeader, onchange: (e) => { hasHeader = e.target.checked; chosenColumn = null; render(); } }), ' First row is a header'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Column with the text to judge'), column),
      expectedList.length > 0
        ? h('div', {}, h('p', { class: 'field-label' }, 'Expected answers found (used by the accuracy check)'), h('ul', { class: 'plain-list' }, expectedList.map(([id, col]) => h('li', {}, h('span', { class: 'mono' }, info.headers[col]), ' → ', h('span', { class: 'mono' }, id)))))
        : h('p', { class: 'hint' }, 'Tip: add columns named expected_<question_id> (for example expected_department) to check how often Jev agrees with you.'),
      info.unmatched.length > 0 && h('p', { class: 'notice' }, `Ignored, no question with that id: ${info.unmatched.join(', ')}`),
      h('p', { class: 'field-label' }, `Preview (${items.length} item${items.length === 1 ? '' : 's'}${truncated ? `, first ${items.length} of ${total}` : ''})`),
      h('ul', { class: 'plain-list csv-preview' }, items.slice(0, 3).map((i) => h('li', {}, i.text.length > 120 ? `${i.text.slice(0, 120)}…` : i.text))),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', id: 'csv-import', class: 'btn btn-primary btn-sm', disabled: items.length === 0, onclick: () => { onImport({ items, truncated, total }); dialog.close(); } }, `Import ${items.length} item${items.length === 1 ? '' : 's'}`),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dialog.close() }, 'Cancel'),
      ),
    );
  }

  render();
  dialog.showModal();
}

/* ---------- wiring ---------- */

export function initDialogs(hooks) {
  $('#history-btn').addEventListener('click', () => {
    $('#history-search').value = '';
    renderHistory(hooks.restoreRun);
    $('#history-dialog').showModal();
  });
  $('#history-search').addEventListener('input', () => renderHistory(hooks.restoreRun));
  $('#history-clear').addEventListener('click', () => {
    app.history = [];
    save.history();
    renderHistory(hooks.restoreRun);
    hooks.onHistoryChanged?.();
  });

  $('#sets-btn').addEventListener('click', () => {
    renderSets(hooks);
    $('#sets-dialog').showModal();
  });
}
