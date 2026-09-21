import { h } from '../dom.js';
import { groupClipChars, groupSizeFor, STEAM_GROUPS, STEAM_GROUP_SIZES, STEAM_PLATFORM, STEAM_QUESTION_IDS, STEAM_TOPICS, tokensPerReviewEstimate } from '../lib/steam.js';

const BASICS = ['positive', 'worth_price', 'pay_to_win', 'performance', 'stability', 'replayability']; // the six the page started with: the cheapest way to see what matters most
const number = (n) => n.toLocaleString('en-US');

/**
 * The settings that decide what Jev is asked and how much it costs: a checkbox for every question, grouped under the same
 * headings as the cards, and a checkbox for reading reviews in groups instead of one by one. Both change the token cost
 * per review, which is shown as they change. `slice` is the Steam page's state (`topics`, `grouped`, `groupSize`);
 * `onChange` is called after any of it changes.
 */
export function createModesPanel({ slice, onChange }) {
  const boxes = new Map(); // question id -> its checkbox
  const groupBoxes = new Map(); // heading id -> the checkbox that switches its whole group

  const enabled = (id) => slice.topics.includes(id);
  const setTopics = (ids) => {
    // The platform question only means something with the performance one, so it goes when that does.
    const next = new Set(ids);
    if (!next.has('performance')) next.delete(STEAM_PLATFORM.id);
    slice.topics = STEAM_QUESTION_IDS.filter((id) => next.has(id));
    onChange();
    refresh();
  };
  const toggle = (id, on) => setTopics(on ? [...slice.topics, id] : slice.topics.filter((x) => x !== id));

  const checkbox = (id, text, title) => {
    const input = h('input', { type: 'checkbox', 'data-question': id, onchange: (e) => toggle(id, e.target.checked) });
    boxes.set(id, input);
    return h('label', { class: 'check steam-question', title }, input, ` ${text}`);
  };

  const groupBlock = (group) => {
    const topics = STEAM_TOPICS.filter((t) => t.group === group.id);
    const ids = topics.map((t) => t.id);
    const all = h('input', {
      type: 'checkbox',
      'aria-label': `All of ${group.label}`,
      onchange: (e) => setTopics(e.target.checked ? [...new Set([...slice.topics, ...ids])] : slice.topics.filter((id) => !ids.includes(id))),
    });
    groupBoxes.set(group.id, { input: all, ids });
    return h(
      'div',
      { class: 'steam-question-group' },
      h('label', { class: 'check steam-question-heading' }, all, ` ${group.label}`),
      h(
        'div',
        { class: 'steam-question-list' },
        topics.map((t) => checkbox(t.id, t.label, t.question)),
        // Performance by platform is the one question that is not a topic of its own; it goes with Technical.
        group.id === 'technical' ? checkbox(STEAM_PLATFORM.id, 'Performance by platform', 'Which platform or hardware the reviewer plays on, set beside whether it runs well there. Needs "Runs badly" too, and reviews read one by one.') : null,
      ),
    );
  };

  const headline = h('span', { class: 'panel-headline' });
  const preset = (label, ids, title) => h('button', { type: 'button', class: 'btn btn-sm', title, onclick: () => setTopics(ids) }, label);
  const details = h(
    'details',
    { class: 'explainer steam-questions' },
    h('summary', {}, h('span', {}, 'Questions Jev is asked'), headline),
    h('div', { class: 'steam-question-tools' }, preset('All', STEAM_QUESTION_IDS, 'Ask every question'), preset('The six basics', BASICS, 'Positive, worth the price, pay to win, runs badly, bugs and crashes, lasting appeal: the questions this page started with'), preset('None', [], 'Switch every question off, then tick the ones you want')),
    ...STEAM_GROUPS.map(groupBlock),
  );

  const groupedBox = h('input', { type: 'checkbox', id: 'steam-grouped', onchange: (e) => { slice.grouped = e.target.checked; onChange(); refresh(); } });
  const sizeSelect = h('select', { id: 'steam-group-size', 'aria-label': 'Reviews in a group', onchange: (e) => { slice.groupSize = e.target.value === 'max' ? 'max' : Number(e.target.value); onChange(); refresh(); } }, STEAM_GROUP_SIZES.map((n) => h('option', { value: String(n) }, n === 'max' ? 'Max (a whole batch)' : String(n))));
  const groupedNote = h('p', { class: 'hint' });

  const groupedRow = h(
    'div',
    { class: 'steam-grouping' },
    h('label', { class: 'check', title: 'Send many reviews to Jev in one request and ask what share of them say each thing, instead of one request per review.' }, groupedBox, ' Group reviews to make it cheaper'),
    h('label', { class: 'small' }, ' Group size ', sizeSelect),
  );

  /** Bring every control in line with the page's state, and say what it costs. */
  function refresh() {
    for (const [id, input] of boxes) input.checked = enabled(id);
    for (const { input, ids } of groupBoxes.values()) {
      const on = ids.filter(enabled).length;
      input.checked = on === ids.length;
      input.indeterminate = on > 0 && on < ids.length;
    }
    // Performance by platform needs the performance question, and each review's own answers, so not with groups.
    const platform = boxes.get(STEAM_PLATFORM.id);
    platform.disabled = !enabled('performance') || slice.grouped;

    groupedBox.checked = slice.grouped;
    sizeSelect.value = String(slice.groupSize);
    sizeSelect.disabled = !slice.grouped;

    const each = tokensPerReviewEstimate({ topics: slice.topics });
    const size = groupSizeFor(slice.groupSize, slice.count);
    const grouped = tokensPerReviewEstimate({ topics: slice.topics, grouped: true, groupSize: size });
    const count = slice.topics.length;
    headline.textContent = `${count} of ${STEAM_QUESTION_IDS.length} on · about ${number(slice.grouped ? grouped : each)} tokens a review${slice.grouped ? ` in groups of ${size}` : ''}`;
    groupedNote.textContent = slice.grouped
      ? `Reviews are sent ${size} at a time${slice.groupSize === 'max' ? ' (a whole batch in one request' + (groupClipChars(size) < 500 ? `, each review cut to ${groupClipChars(size)} characters to fit` : '') + ')' : ''} and Jev is asked what share of each group says each thing, so the cards are estimates (marked ≈), and there is no table, no filter and no accuracy check against the thumbs. About ${number(grouped)} tokens a review, against ${number(each)} one by one (${(each / grouped).toFixed(0)} times cheaper).`
      : `One request per review gives exact counts and a table you can filter. Grouping sends ${size} at a time instead, at about ${number(grouped)} tokens a review against ${number(each)} (${(each / grouped).toFixed(0)} times cheaper), but the counts become estimates and there is no table.`;
  }

  refresh();
  return { element: h('div', { class: 'steam-modes' }, details, groupedRow, groupedNote), refresh };
}
