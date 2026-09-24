import { h } from '../dom.js';
import { app, save, setBatchSlice } from './state.js';
import { initBulk } from './bulk.js';

/**
 * The page a question set saved from Batch opens on. It is the other set page's shape — the set's name and what to
 * paste, then a box that fills the height, then the results below it — run the way this kind of set is meant to be:
 * each pasted line is one item, judged on its own against the set's questions, one request each, with the same table
 * Batch gets. Nothing is loaded onto the Batch page to do it.
 *
 * The running is `initBulk`'s, as Batch's is; this adds only what is the set's own — its name, its description, and
 * the items and results kept per set, which `open(id)` swaps in. One page serves every such set.
 */
export function createSetBatchPage({ openCsv, onEditInBatch }) {
  let setId = null;
  const current = () => app.sets.find((s) => s.id === setId) ?? null;
  // Before the first open, and after the set is deleted, there is no set: an empty slice keeps the controller happy.
  const blank = { text: '', imported: [], concurrency: 3, run: null };

  const title = h('h2', { id: 'setbatch-title' });
  const lede = h('p', { id: 'setbatch-lede' });
  const savedFrom = h('span', { class: 'tag' }, 'Saved from Batch');

  const editBtn = h(
    'button',
    {
      type: 'button',
      id: 'setbatch-edit',
      class: 'btn',
      title: "Put this set's questions on the Batch page to see or change them. Running them does not need this.",
      onclick: () => setId && onEditInBatch(setId),
    },
    'Edit in Batch',
  );

  const bulk = initBulk('setbatch', {
    openCsv,
    slice: () => (current() ? setBatchSlice(setId) : blank),
    persist: () => save.setBatch(),
    questions: () => current()?.questions ?? null,
    questionIds: () => Object.keys(current()?.questions ?? {}),
    label: () => current()?.name,
    panelHead: [h('div', { class: 'set-lede' }, title, lede), savedFrom],
    hint: '',
    placeholder: 'One item per line. Each is judged on its own against this set\'s questions, one request per item.',
    hideEmptyResults: true, // nothing under the box until a run, as on the other set page
    saveButton: false,
    extraButtons: [editBtn],
    // The questions belong to the set, so "New query" clears only what is this page's: the items and the results.
    onReset: () => {},
    resetAsks: () => '',
  });

  /** Point the page at another set: its name, and its own items and results. */
  function open(id) {
    // Anything typed for the set being left is written before the slice underneath changes, not 400ms later.
    if (setId && setId !== id) bulk.flush();
    setId = id;
    const set = current();
    title.textContent = set?.name ?? 'Question set';
    savedFrom.hidden = !set;
    editBtn.disabled = !set;
    // The set's own description says what to paste; a set without one gets a plain line.
    const count = set ? Object.keys(set.questions).length : 0;
    lede.textContent = set
      ? set.description || `${count} question${count === 1 ? '' : 's'} asked of each line you paste below.`
      : 'This question set no longer exists.';
    lede.className = set?.description ? 'set-description' : 'hint';
    bulk.refresh(); // the items and results of this set, in place of the last one's
  }

  return { open, start: () => bulk.start(), reset: () => bulk.reset(), currentId: () => setId };
}
