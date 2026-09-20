import { h } from '../dom.js';
import { downloadText } from './download.js';
import { formatBytes, readableText } from '../lib/files.js';

/**
 * An Import and an Export button with a small status line, for any text input.
 *  - `onImport({ file, text, say })` gets the cleaned-up file contents (size and "is it text" are checked first).
 *  - `getExport()` returns `{ filename, text, mime }`, or null when there is nothing to export yet.
 * The hidden file input takes `inputId` so it can be reached directly.
 */
export function fileActions({ idPrefix, inputId, accept, maxBytes, importLabel = 'Import…', exportLabel = 'Export', onImport, getExport }) {
  const status = h('span', { class: 'file-status small', role: 'status', hidden: true });
  const say = (message, isError = false) => {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle('is-error', isError);
  };

  const input = h('input', {
    type: 'file',
    id: inputId,
    accept,
    hidden: true,
    onchange: async (e) => {
      const file = e.target.files[0];
      e.target.value = ''; // so choosing the same file twice still fires
      if (!file) return;
      if (file.size > maxBytes) return say(`That file is too large (${formatBytes(maxBytes)} max).`, true);
      let text;
      try {
        text = readableText(await file.text());
      } catch (err) {
        return say(err.message, true);
      }
      say('');
      onImport({ file, text, say });
    },
  });

  const importBtn = h('button', { type: 'button', id: `${idPrefix}-import`, class: 'btn btn-ghost btn-sm', onclick: () => input.click() }, importLabel);
  const exportBtn = h(
    'button',
    {
      type: 'button',
      id: `${idPrefix}-export`,
      class: 'btn btn-ghost btn-sm',
      onclick: () => {
        const out = getExport();
        if (!out) return say('Nothing to export yet.');
        downloadText(out.filename, out.text, out.mime);
        say(`Exported ${out.filename}.`);
      },
    },
    exportLabel,
  );

  return { element: h('div', { class: 'file-actions' }, importBtn, exportBtn, input, status), say };
}
