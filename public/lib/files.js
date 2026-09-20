import { toCsv } from './csv.js';

// One input has to fit in the 1 MB request body the local server accepts, with room for the questions.
export const MAX_INPUT_BYTES = 500_000;

/** Clean up text read from a file: drop a BOM, unify line endings, and refuse things that are not text. */
export function readableText(raw) {
  if (raw.includes('\u0000')) throw new Error('That does not look like a text file.');
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${Number((bytes / 1_000_000).toFixed(1))} MB`;
  return `${Math.round(bytes / 1000)} KB`;
}

/**
 * Items (Batch items, Rank candidates) as a file. Plain text, one per line, unless some items carry expected answers:
 * then a CSV with `text` and `expected_<question_id>` columns, which the CSV import reads straight back.
 */
export function exportItems(items) {
  const ids = [...new Set(items.flatMap((item) => Object.keys(item.expected ?? {})))];
  if (ids.length === 0) return { ext: 'txt', mime: 'text/plain', text: `${items.map((i) => i.text).join('\n')}\n` };

  const rows = [['text', ...ids.map((id) => `expected_${id}`)], ...items.map((i) => [i.text, ...ids.map((id) => i.expected?.[id] ?? '')])];
  return { ext: 'csv', mime: 'text/csv', text: `﻿${toCsv(rows)}` };
}
