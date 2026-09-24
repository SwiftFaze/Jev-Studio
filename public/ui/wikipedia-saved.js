import { h } from '../dom.js';
import { app, save } from './state.js';
import { flash } from './save-set.js';
import { answerBlock, statsView, stepsView } from './wikipedia-view.js';

const $ = (selector) => document.querySelector(selector);

/** Show or hide the saved answers under Wikipedia answer, from the arrow beside it. */
export function toggleWikipediaSavedMenu() {
  app.wikipedia.menuOpen = !app.wikipedia.menuOpen;
  save.wikipediaMenu();
  renderWikipediaSavedMenu();
}

/**
 * The saved answers, listed under Wikipedia answer in the menu: one entry each, every one a page of its own (so the
 * Wikipedia answer page itself is not the one that looks selected while a saved answer is open).
 */
export function renderWikipediaSavedMenu() {
  const list = $('#wikipedia-saved-menu');
  const toggle = $('#wikipedia-toggle');
  const { saved, menuOpen } = app.wikipedia;
  const any = saved.length > 0;
  toggle.hidden = !any; // nothing to show or hide until an answer has been saved
  toggle.setAttribute('aria-expanded', String(menuOpen));
  list.hidden = !any || !menuOpen;
  list.replaceChildren(
    ...saved.map((a) =>
      h(
        'li',
        {},
        h(
          'button',
          { type: 'button', class: 'nav-item', 'data-mode': `wikipediasaved:${a.id}`, 'aria-pressed': String(app.mode === `wikipediasaved:${a.id}`), title: `${a.question}: ${a.text}` },
          h('span', { class: 'nav-name' }, a.question),
        ),
      ),
    ),
  );
}

/**
 * The page a saved answer is shown on, the same for every one: the question on top, then the answer, then how Jev got there.
 * The bottom bar has Ask again (back to the Wikipedia answer page with the question in the box) and Remove.
 */
export function createWikipediaSavedPage({ onAskAgain, onRemoved, openInSingle }) {
  let currentId = null;
  const current = () => app.wikipedia.saved.find((a) => a.id === currentId) ?? null;

  const questionText = h('p', { id: 'wikipediasaved-question', class: 'wiki-question-text' });
  const savedOn = h('span', { class: 'tag' });
  $('#mode-wikipediasaved').replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Question'), savedOn), questionText));

  const askBtn = h('button', { type: 'button', id: 'wikipediasaved-ask', class: 'btn btn-primary', title: 'Put the question back in the box on the Wikipedia answer page, to look it up again', onclick: () => current() && onAskAgain(current().question) }, 'Ask again');
  const removeBtn = h('button', { type: 'button', id: 'wikipediasaved-remove', class: 'btn', onclick: () => remove() }, 'Remove');
  $('#runbar-wikipediasaved').replaceChildren(askBtn, removeBtn);

  function remove() {
    const a = current();
    if (!a || !confirm('Remove this saved answer?')) return;
    app.wikipedia.saved = app.wikipedia.saved.filter((x) => x.id !== a.id);
    save.wikipediaSaved();
    renderWikipediaSavedMenu();
    flash('Saved answer removed.');
    onRemoved();
  }

  /** Draw the saved answer with this id. */
  function open(id) {
    currentId = id;
    const a = current();
    if (!a) return;
    questionText.textContent = a.question;
    savedOn.textContent = `Saved ${new Date(a.ts).toLocaleDateString()}`;
    $('#wikipediasaved-answer').replaceChildren(answerBlock(a));
    $('#wikipediasaved-trail').replaceChildren(
      statsView(a.stats, { checked: a.checked }),
      a.trail.length > 0 ? stepsView(a.trail, { chosenText: a.text, openInSingle }) : h('p', { class: 'muted' }, 'The steps were not kept with this answer.'),
    );
  }

  return { open };
}
