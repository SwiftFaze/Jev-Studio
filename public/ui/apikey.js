import { h } from '../dom.js';
import { checkKey, MAX_KEY_LENGTH } from '../lib/apikey.js';
import { forgetKey, saveKey } from './api.js';

// The API key is encrypted and kept by the app itself, in its data folder. The browser only ever sends it once, when
// you paste it here; after that it is never in the page again, so this file has no key to hold or show, only a masked
// hint (`ts_••••cdef`) that the server reports in its status.

const LEGACY_KEY = 'jev-studio:apikey:v1'; // where earlier versions kept the key, in this browser's storage

const $ = (selector) => document.querySelector(selector);

/** What the sidebar and the banner say about where the key comes from. */
export function describeKeySource(status) {
  if (status.mock) return 'Sample data: no API key needed.';
  if (status.keyUnreadable && status.keySource !== 'stored') return 'The saved key cannot be read on this computer. Enter it again.';
  if (status.keySource === 'stored') return `Using the API key saved in this app (${status.keyHint}), stored encrypted on this computer.`;
  if (status.keySource === '.env') return 'Using the key in the .env file.';
  if (status.keySource === 'environment') return 'Using the key in your environment variables.';
  return 'No API key yet.';
}

let hooks = { onChanged: () => {}, getStatus: () => ({}) };

export function initApiKey(options) {
  hooks = { ...hooks, ...options };
  $('#key-btn').addEventListener('click', openApiKey);
}

/**
 * Earlier versions kept a pasted key in this browser's storage. Move it into the app's encrypted store, then delete
 * it here. Returns the new status, or null when there was nothing to move (or the server refused it, in which case
 * the old copy is left for the person to re-enter rather than silently lost).
 */
export async function migrateLegacyKey() {
  let key = null;
  for (const store of [() => localStorage, () => sessionStorage]) {
    try {
      const raw = store().getItem(LEGACY_KEY);
      if (raw) key ??= JSON.parse(raw);
    } catch {
      /* storage blocked or not JSON: nothing to migrate from here */
    }
  }
  if (typeof key !== 'string' || !checkKey(key).ok) return null;
  let status;
  try {
    status = await saveKey(key);
  } catch {
    return null;
  }
  for (const store of [() => localStorage, () => sessionStorage]) {
    try {
      store().removeItem(LEGACY_KEY);
    } catch {
      /* same */
    }
  }
  return status;
}

export function openApiKey() {
  const dialog = $('#key-dialog');
  const body = $('#key-body');
  const status = hooks.getStatus();
  const hasStored = status.keySource === 'stored';

  const input = h('input', {
    class: 'text',
    id: 'key-input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: false,
    maxLength: MAX_KEY_LENGTH + 16, // room for a pasted "Bearer " prefix; the check gives the real message
    placeholder: hasStored ? 'Paste a new key to replace it' : 'Paste your TypeSafe API key',
    'aria-label': 'API key',
  });
  const note = h('p', { id: 'key-note', class: 'hint', role: 'status' });
  const saveBtn = h('button', { type: 'button', id: 'key-save', class: 'btn btn-primary btn-sm', onclick: doSave }, hasStored ? 'Replace key' : 'Save key');

  const fail = (message) => {
    note.className = 'error';
    note.textContent = message;
    saveBtn.disabled = false;
  };

  async function doSave() {
    const checked = checkKey(input.value);
    if (!checked.ok) {
      fail(checked.error);
      input.focus();
      return;
    }
    saveBtn.disabled = true;
    try {
      const next = await saveKey(checked.key);
      input.value = '';
      dialog.close();
      hooks.onChanged(next, `Key saved (${next.keyHint}), encrypted on this computer. It is used for your next request.`);
    } catch (err) {
      fail(err.message);
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSave();
    }
  });
  input.addEventListener('input', () => {
    note.className = 'hint';
    note.textContent = '';
  });

  body.replaceChildren(
    ...[
      h('p', { class: 'hint' }, 'Paste your TypeSafe API key. Jev Studio encrypts it and keeps it in its own data folder on this computer, so you only enter it once. It is never shown again in full, never sent anywhere except TypeSafe, and never included in exports.'),
      h('p', { id: 'key-current', class: hasStored ? 'notice-ok' : 'hint' }, describeKeySource(status)),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'API key'), input),
      note,
      h(
        'div',
        { class: 'dialog-actions' },
        saveBtn,
        hasStored && h('button', { type: 'button', id: 'key-remove', class: 'btn btn-sm', onclick: async () => {
          try {
            const next = await forgetKey();
            dialog.close();
            hooks.onChanged(next, 'Saved key removed from this computer.');
          } catch (err) {
            fail(err.message);
          }
        } }, 'Remove key'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dialog.close() }, 'Cancel'),
      ),
    ].filter(Boolean),
  );

  dialog.showModal();
  input.focus();
}
