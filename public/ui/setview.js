import { h } from '../dom.js';
import { app } from './state.js';
import { describeQuestions } from '../lib/library.js';

const $ = (selector) => document.querySelector(selector);

/** One question, drawn as it is saved: the id and its type, the question, then whatever that type offers. */
function questionCard(q) {
  const body = [];
  if (q.instructions) body.push(h('p', { class: 'setview-instructions' }, q.instructions));
  else body.push(h('p', { class: 'hint' }, 'This question has no text.'));

  if (q.options.length > 0) {
    body.push(
      h(
        'div',
        { class: 'criteria' },
        h('span', { class: 'field-label' }, q.type === 'noul' ? 'What yes and no mean' : 'Options'),
        h(
          'ul',
          { class: 'plain-list setview-options' },
          q.options.map((o) => h('li', {}, h('span', { class: 'mono' }, o.key), o.desc ? ` — ${o.desc}` : '')),
        ),
      ),
    );
  }
  if (q.levels.length > 0) {
    body.push(
      h(
        'div',
        { class: 'criteria' },
        h('span', { class: 'field-label' }, `Levels, lowest first (${q.levels.length})`),
        h(
          'div',
          { class: 'rows' },
          q.levels.map((level, i) => h('div', { class: 'row' }, h('span', { class: 'level-index' }, String(i)), h('span', {}, level))),
        ),
      ),
    );
  }

  return h(
    'div',
    { class: 'q-card' },
    h('div', { class: 'q-head' }, h('span', { class: 'q-id mono' }, q.id), h('span', { class: 'tag' }, q.label)),
    ...body,
  );
}

/**
 * The page a question set saved from Batch opens on. It is read-only on purpose: such a set runs each pasted line as
 * its own item against these questions, and Batch is the only page that does that (see `isViewOnly`), so there is
 * nothing to run here. It shows what is in the set — every question, its type and what it offers — and the bottom bar
 * takes it to Batch. One page serves every such set, re-pointed by `open(id)`.
 *
 * `onOpenInBatch(id)` puts the set's questions on the Batch page; it asks first if that would replace questions
 * already there, and returns false when the answer was no.
 */
export function createSetViewPage({ onOpenInBatch }) {
  let setId = null;
  const current = () => app.sets.find((s) => s.id === setId) ?? null;

  const title = h('h2', { id: 'setview-title' });
  const lede = h('p', { id: 'setview-lede' });
  const savedFrom = h('span', { class: 'tag' }, 'Saved from Batch');
  const list = h('div', { class: 'questions', id: 'setview-questions' });

  $('#mode-setview').replaceChildren(
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'set-lede' }, title, lede), savedFrom),
      list,
    ),
  );

  const openBtn = h(
    'button',
    {
      type: 'button',
      id: 'setview-open',
      class: 'btn btn-primary',
      title: "Put this set's questions on the Batch page, where you paste the items and run them one at a time",
      onclick: () => setId && onOpenInBatch(setId),
    },
    'Open in Batch',
  );
  const count = h('span', { class: 'hint', id: 'setview-count' });
  $('#runbar-setview').replaceChildren(openBtn, count);

  /** Point the page at another set (or draw it again after the set changed). */
  function open(id) {
    setId = id;
    const set = current();
    title.textContent = set?.name ?? 'Question set';
    savedFrom.hidden = !set;
    openBtn.disabled = !set;

    if (!set) {
      lede.textContent = 'This question set no longer exists.';
      lede.className = 'hint';
      list.replaceChildren();
      count.textContent = '';
      return;
    }

    const questions = describeQuestions(set.questions);
    // The set's own description says what it is for; without one, what the page is showing.
    lede.textContent = set.description || 'Every item you paste on the Batch page is judged against these questions.';
    lede.className = set.description ? 'set-description' : 'hint';
    list.replaceChildren(...questions.map(questionCard));
    count.textContent = `${questions.length} question${questions.length === 1 ? '' : 's'} · read-only`;
  }

  return { open, currentId: () => setId };
}
