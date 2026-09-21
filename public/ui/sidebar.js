import { h } from '../dom.js';
import { app, save } from './state.js';

const $ = (selector) => document.querySelector(selector);

/** The Question sets submenu: one entry per saved set, each its own page. Call again whenever the sets change. */
export function renderSetsMenu() {
  const list = $('#sets-menu');
  const items = app.sets.map((set) => {
    const count = Object.keys(set.questions).length;
    return h(
      'li',
      {},
      h(
        'button',
        { type: 'button', class: 'nav-item', 'data-mode': `set:${set.id}`, 'aria-pressed': String(app.mode === `set:${set.id}`), title: `${set.name} (${count} question${count === 1 ? '' : 's'})${set.description ? `: ${set.description}` : ''}` },
        h('span', { class: 'nav-name' }, set.name),
        h('span', { class: 'nav-count' }, String(count)),
      ),
    );
  });
  list.replaceChildren(...(items.length > 0 ? items : [h('li', { class: 'nav-empty' }, 'No saved sets yet')]));
}

function applySetsMenuState() {
  const open = app.setsMenuOpen;
  $('#sets-toggle').setAttribute('aria-expanded', String(open));
  $('#sets-arrow').setAttribute('aria-expanded', String(open)); // the arrow follows it (its CSS turns on this)
  $('#sets-menu').hidden = !open;
  $('#sets-btn').hidden = !open;
}

export function closeMenu() {
  document.body.classList.remove('menu-open');
  $('#menu-btn').setAttribute('aria-expanded', 'false');
}

/**
 * Wire the side menu. `onNavigate(mode)` is called for every page or set the user picks.
 * On a phone the menu is a drawer: the Menu button opens it, and picking a page, the backdrop or Escape closes it.
 */
export function initSidebar({ onNavigate }) {
  $('#mode-nav').addEventListener('click', (e) => {
    const item = e.target.closest('[data-mode]');
    if (item) onNavigate(item.dataset.mode);
  });

  // The name and the arrow beside it do the same thing. The arrow is for the mouse: the name is the one button for the keyboard and screen readers.
  const toggleSets = () => {
    app.setsMenuOpen = !app.setsMenuOpen;
    save.setsMenu();
    applySetsMenuState();
  };
  $('#sets-toggle').addEventListener('click', toggleSets);
  $('#sets-arrow').addEventListener('click', toggleSets);

  $('#menu-btn').addEventListener('click', () => {
    const open = document.body.classList.toggle('menu-open');
    $('#menu-btn').setAttribute('aria-expanded', String(open));
  });
  $('#scrim').addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  renderSetsMenu();
  applySetsMenuState();
}
