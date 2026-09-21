import { h } from '../dom.js';
import { app, save } from './state.js';
import { flash } from './save-set.js';
import { renderBatchResults } from './batch-results.js';
import { renderSteamVerdict } from './steam-verdict.js';
import { deleteBatch, getBatch, putBatch } from './idb.js';
import { describeSteamReview, savedGroupTally, savedGroupTotal, savedTally, savedTotal, snapshotOf, steamFilter, steamFilterChoices, storeUrl } from '../lib/steam.js';
import { pct } from '../results.js';

const $ = (selector) => document.querySelector(selector);
const number = (n) => n.toLocaleString('en-US');
const plural = (n, word, many = `${word}s`) => `${number(n)} ${n === 1 ? word : many}`;
const compact = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const newId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PAGE_SIZE = 25; // reviews per page in the table, as on the Steam page

let hooks = { onChanged: () => {} };
/** `onChanged` is called after a saved analysis is added, replaced or deleted (the menu is redrawn here already). */
export function initSteamSaved(options) {
  hooks = { ...hooks, ...options };
}

const findByName = (name) => app.steamSaved.find((a) => a.name.toLowerCase() === name.trim().toLowerCase());

/** Show or hide the saved analyses under Steam reviews, from the arrow beside it. */
export function toggleSteamSavedMenu() {
  app.steamMenuOpen = !app.steamMenuOpen;
  save.steamMenu();
  renderSteamSavedMenu();
}

/** The saved analyses, listed under Steam reviews in the menu: one entry each, every one a page of its own. */
export function renderSteamSavedMenu() {
  const list = $('#steam-saved-menu');
  const toggle = $('#steam-toggle');
  const any = app.steamSaved.length > 0;
  toggle.hidden = !any; // nothing to show or hide until an analysis has been saved
  toggle.setAttribute('aria-expanded', String(app.steamMenuOpen));
  list.hidden = !any || !app.steamMenuOpen;
  list.replaceChildren(
    ...app.steamSaved.map((a) => {
      const analysed = savedTotal(a).answered + savedGroupTotal(a).reviews;
      return h(
        'li',
        {},
        h(
          'button',
          { type: 'button', class: 'nav-item', 'data-mode': `steamsaved:${a.id}`, 'aria-pressed': String(app.mode === `steamsaved:${a.id}`), title: `${a.name}: ${plural(analysed, 'review')} analysed${a.note ? `. ${a.note}` : ''}` },
          h('span', { class: 'nav-name' }, a.name),
          h('span', { class: 'nav-count' }, compact(analysed)),
        ),
      );
    }),
  );
}

/**
 * The Save button on the Steam page: keep the analysis so far as an entry under Steam reviews in the menu. The small
 * record (the counts, and where the next batch starts) goes in local storage; the batch on screen, about 4 KB a review,
 * goes in the browser's database, so the saved page can show its table. If the browser will not keep the reviews the
 * analysis is still saved, as counts only. Saving under a title that already exists says so, and the button changes from
 * Save to Overwrite.
 */
export function openSaveSteam() {
  const slice = app.steam;
  if (slice.batches === 0) return flash('Nothing to save yet: analyse a batch first.');

  const dialog = $('#steam-save-dialog');
  const body = $('#steam-save-body');
  const snapshot = snapshotOf(slice);
  const total = savedTally(snapshot);
  const groupTotal = savedGroupTally(snapshot); // reviews read in groups, which are estimates
  const linked = app.steamSaved.find((a) => a.id === slice.savedId); // the one this was carried on from: saving again offers to overwrite it

  const nameInput = h('input', { class: 'text', id: 'steam-save-name', maxLength: 80, value: linked?.name ?? slice.game?.name ?? '', placeholder: 'For example: Deep Rock Galactic, most recent', 'aria-label': 'Title' });
  const noteInput = h('textarea', { class: 'text', id: 'steam-save-note', rows: 3, maxLength: 500, value: linked?.note ?? '', placeholder: 'A note for yourself. Optional.', 'aria-label': 'Note' });
  const hint = h('p', { id: 'steam-save-hint', class: 'hint', role: 'status' });
  const confirmBtn = h('button', { type: 'button', id: 'steam-save-confirm', class: 'btn btn-primary btn-sm', onclick: doSave });

  function update() {
    const name = nameInput.value.trim();
    const existing = name ? findByName(name) : null;
    confirmBtn.textContent = existing ? 'Overwrite' : 'Save';
    confirmBtn.disabled = !name;
    hint.className = existing ? 'notice' : 'hint';
    hint.textContent = existing ? `An analysis titled "${existing.name}" already exists (${plural(savedTotal(existing).answered, 'review')}). Overwrite replaces it with this one.` : '';
  }

  async function doSave() {
    const name = nameInput.value.trim();
    if (!name || confirmBtn.disabled) return;
    confirmBtn.disabled = true; // saving takes a moment, and a second click must not start a second save
    const existing = findByName(name);
    const id = existing?.id ?? newId();
    const { run, ...rest } = snapshot;

    // The reviews first. If the browser will not keep them, keep the counts only, with the batch folded into them.
    let hasRun = false;
    if (run) {
      try {
        await putBatch(id, run);
        hasRun = true;
      } catch {
        await deleteBatch(id).catch(() => {}); // nothing half-saved is left behind
      }
    } else if (existing?.hasRun) {
      await deleteBatch(id).catch(() => {});
    }

    const record = { id, name, note: noteInput.value.trim(), savedAt: new Date().toISOString(), ...rest, tally: run && !hasRun ? total : snapshot.tally, gtally: run && !hasRun ? groupTotal : snapshot.gtally, total, gtotal: groupTotal, hasRun };
    const before = app.steamSaved;
    app.steamSaved = existing ? before.map((a) => (a.id === existing.id ? record : a)) : [...before, record];
    if (!save.steamSaved()) {
      app.steamSaved = before; // the browser had no room for the record: keep what was there, and do not leave the reviews orphaned
      if (hasRun && !existing?.hasRun) await deleteBatch(id).catch(() => {});
      dialog.close();
      return flash('Could not save: the browser has no room left for it. Delete a saved analysis and try again.');
    }
    slice.savedId = id;
    save.steam();
    renderSteamSavedMenu();
    hooks.onChanged();
    dialog.close();
    if (run && !hasRun) flash(`${existing ? 'Overwrote' : 'Saved'} "${name}" with its counts only: the browser would not keep the reviews, so there is no table.`);
    else flash(existing ? `Overwrote "${name}".` : `Saved "${name}". It is under Steam reviews in the menu.`);
  }

  nameInput.addEventListener('input', update);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSave();
    }
  });

  body.replaceChildren(
    h('p', { class: 'hint' }, `Saves ${plural(total.answered + groupTotal.reviews, 'analysed review')} in ${plural(slice.batches, 'batch', 'batches')} and where the next batch starts, as a page under Steam reviews in the menu.${snapshot.run?.kind === 'steam' ? ` It keeps the reviews of the batch on screen too (${plural(snapshot.run.rows.length, 'review')}), so the saved page can show them in a table.` : snapshot.run ? ' It keeps the groups of the batch on screen that have not been asked about yet, so they can be finished.' : ''} Continue analysis on that page brings it back here.`),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Title'), nameInput),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Note (optional)'), noteInput),
    hint,
    h('div', { class: 'dialog-actions' }, confirmBtn, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dialog.close() }, 'Cancel')),
  );
  update();
  dialog.showModal();
  nameInput.focus();
  nameInput.select();
}

/**
 * The page for one saved analysis: what it is, the results (the same cards as on the tool page), and the table of the
 * batch it was saved with, which you can filter by clicking a count on a card. Continue analysis and Delete are in the
 * bottom bar, where the run buttons are on the Steam page. One page serves every saved analysis, re-pointed by open(id).
 */
export function createSteamSavedPage({ onContinue, onDeleted }) {
  let currentId = null;
  let opening = 0; // which call to open() is the latest, so a slow read for one analysis never draws over the next
  let handle = null; // the table's controls (its filter), once it is drawn
  let saveTimer = null;
  const current = () => app.steamSaved.find((a) => a.id === currentId) ?? null;

  const title = h('h2', { id: 'steamsaved-title' });
  const lede = h('p', { id: 'steamsaved-note', class: 'set-description' });
  const facts = h('p', { id: 'steamsaved-facts', class: 'small muted' });
  const continueBtn = h('button', { type: 'button', id: 'steamsaved-continue', class: 'btn btn-primary', onclick: () => current() && onContinue(current()) }, 'Continue analysis');
  const deleteBtn = h('button', { type: 'button', id: 'steamsaved-delete', class: 'btn', onclick: () => remove() }, 'Delete');

  $('#mode-steamsaved').replaceChildren(
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'set-lede' }, title, lede), h('span', { class: 'tag' }, 'Saved analysis')),
      facts,
    ),
  );
  // The bottom bar, where the run buttons are on the Steam page.
  $('#runbar-steamsaved').replaceChildren(continueBtn, deleteBtn);

  async function remove() {
    const a = current();
    if (!a || !confirm(`Delete "${a.name}"? Its results and reviews are removed from the menu. The Steam reviews page itself is not changed.`)) return;
    app.steamSaved = app.steamSaved.filter((x) => x.id !== a.id);
    save.steamSaved();
    if (app.steam.savedId === a.id) {
      app.steam.savedId = null;
      save.steam();
    }
    await deleteBatch(a.id).catch(() => {});
    renderSteamSavedMenu();
    flash(`Deleted "${a.name}".`);
    onDeleted();
  }

  /** A click on a count on a card: open the table, scroll to it, and show only the reviews that gave that answer. */
  function pick(topic, option) {
    const a = current();
    if (!handle || !a) return;
    handle.setFilter(steamFilter(topic, option, { batches: a.batches, where: 'the batch it was saved with' }));
    const card = $('#steamsaved-table-card');
    card.open = true;
    card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  /** Draw the table of the saved batch, or say why there is not one. `run` comes from the database (or inline, in older saves). */
  function drawTable(a, run) {
    const table = $('#steamsaved-table');
    const headline = $('#steamsaved-table-headline');
    handle = null;
    headline.textContent = '';
    if (!run || run.kind === 'steamgroup') {
      const onlyGroups = savedGroupTotal(a).reviews > 0 && savedTotal(a).answered === 0;
      table.replaceChildren(h('p', { class: 'muted' }, onlyGroups || run ? 'Reviews read in groups have no table: Jev answered about each group as a whole, and the cards are estimates from that.' : a.hasRun ? 'The reviews of this analysis could not be read from the browser, so there is no table. The counts above are kept.' : 'The reviews were not kept with this analysis, so there is no table. Continue analysis and read another batch to see reviews.'));
      return;
    }
    // Only the table is wanted here: the rest of what the results component builds goes into an element that is never shown.
    handle = renderBatchResults(document.createElement('div'), run, {
      pageSize: PAGE_SIZE,
      tableRoot: table,
      onTableHeadline: (text) => { headline.textContent = text; },
      groupSettings: true,
      hideProgressBar: true,
      columns: ['positive'], // a column for every question would not fit; open a row to see every answer
      filterChoices: () => steamFilterChoices({ batches: a.batches, where: 'the batch it was saved with' }),
      // Marks you make on the saved batch are kept with it. (An older save that kept the batch inline is only marked in memory.)
      onChange: () => {
        if (!a.hasRun) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => putBatch(a.id, run).catch(() => {}), 400);
      },
      isRunning: () => false,
      describeRow: (row) => describeSteamReview(row.meta),
    });
  }

  async function open(id) {
    currentId = id;
    const token = ++opening;
    const a = current();
    const root = $('#steamsaved-verdict');
    const card = $('#steamsaved-table-card');
    handle = null;
    if (!a) {
      title.textContent = 'Saved analysis';
      lede.textContent = 'This saved analysis no longer exists.';
      lede.hidden = false;
      facts.replaceChildren();
      continueBtn.disabled = true;
      deleteBtn.disabled = true;
      root.replaceChildren(h('p', { class: 'muted' }, 'There is nothing to show.'));
      $('#steamsaved-group-verdict').replaceChildren();
      $('#steamsaved-table').replaceChildren();
      $('#steamsaved-table-headline').textContent = '';
      return;
    }
    const tally = savedTotal(a);
    const groupTally = savedGroupTotal(a);
    const analysed = tally.answered + groupTally.reviews;
    const verdictOptions = { steamTotal: a.summary?.totalReviews ?? 0, emptyText: groupTally.reviews > 0 && tally.answered === 0 ? '' : undefined };
    const total = a.summary?.totalReviews ?? 0;
    title.textContent = a.name;
    lede.textContent = a.note ?? '';
    lede.hidden = !a.note;
    continueBtn.disabled = false;
    deleteBtn.disabled = false;
    facts.replaceChildren(
      `${a.game?.name ?? 'Steam app'} · `,
      a.game?.appId ? h('a', { href: storeUrl(a.game.appId), target: '_blank', rel: 'noopener noreferrer' }, 'open on Steam') : '',
      a.game?.appId ? ' · ' : '',
      `saved ${new Date(a.savedAt).toLocaleString()} · ${number(analysed)}${total > 0 ? ` of ${number(total)} (${pct(Math.min(1, analysed / total))})` : ''} reviews analysed${tally.answered > 0 && groupTally.reviews > 0 ? ` (${number(tally.answered)} one by one, ${number(groupTally.reviews)} in groups)` : ''} in ${plural(a.batches, 'batch', 'batches')} · ${number(tally.tokens + groupTally.tokens)} tokens · ${a.exhausted ? 'every review Steam has was read' : 'the next batch starts where this stopped'}`,
    );

    // The cards and the header need only the small record, so they are there at once; the table follows once its reviews are read.
    renderSteamVerdict(root, tally, verdictOptions);
    renderSteamVerdict($('#steamsaved-group-verdict'), groupTally.reviews > 0 ? groupTally : null, { steamTotal: total, groups: true, emptyText: '' });
    card.open = true;
    if (!a.hasRun && !a.run) return drawTable(a, null);
    $('#steamsaved-table').replaceChildren(h('p', { class: 'muted' }, 'Reading the saved reviews…'));
    let run = a.run ?? null;
    if (!run) run = await getBatch(a.id).catch(() => null);
    if (token !== opening) return; // another analysis was opened while this one was being read
    drawTable(a, run);
    if (handle) renderSteamVerdict(root, tally, { ...verdictOptions, onPick: pick }); // with a table to filter, the counts become clickable
  }

  return { open };
}
