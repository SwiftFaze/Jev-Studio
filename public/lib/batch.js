// Batch input parsing (text lines and CSV) and the bounded-concurrency runner. No DOM, so it is unit-tested.

export const MAX_ITEMS = 500;
// Errors that would repeat for every item (bad key, no key, invalid questions, server down): stop instead of failing N times.
export const FATAL_STATUSES = new Set([0, 401, 403, 413, 422, 503]);

const TEXT_HEADERS = ['text', 'message', 'content', 'body', 'comment', 'review', 'description', 'input', 'ticket', 'item'];

/** One item per non-blank line. */
export function parseItems(text, max = MAX_ITEMS) {
  const all = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { items: all.slice(0, max).map((t) => ({ text: t, expected: {} })), truncated: all.length > max, total: all.length };
}

/** Header guess: multi-column files nearly always have one; a single column only if it is named like a text column. */
export function guessHeader(rows) {
  const first = rows[0] ?? [];
  if (rows.length < 2) return false;
  return first.length > 1 || TEXT_HEADERS.includes((first[0] ?? '').trim().toLowerCase());
}

/**
 * Work out which CSV column holds the text and which hold expected answers ("expected_<question_id>").
 * Expected columns that match no question are reported so the user knows they were ignored.
 */
export function analyzeCsv(rows, questionIds, hasHeader = guessHeader(rows)) {
  const first = rows[0] ?? [];
  const headers = hasHeader ? first.map((c) => c.trim()) : first.map((_, i) => `Column ${i + 1}`);

  const expected = {};
  const unmatched = [];
  if (hasHeader) {
    headers.forEach((header, i) => {
      const match = /^expected[\s_:-]*(.+)$/i.exec(header);
      if (!match) return;
      const id = questionIds.find((q) => q.toLowerCase() === match[1].trim().toLowerCase());
      if (id) expected[id] = i;
      else unmatched.push(header);
    });
  }

  const taken = new Set(Object.values(expected));
  let textIndex = hasHeader ? headers.findIndex((h, i) => !taken.has(i) && TEXT_HEADERS.includes(h.toLowerCase())) : 0;
  if (textIndex < 0) textIndex = headers.findIndex((_, i) => !taken.has(i));
  if (textIndex < 0) textIndex = 0;

  return { hasHeader, headers, textIndex, expected, unmatched, rowCount: rows.length - (hasHeader ? 1 : 0) };
}

/** Line breaks inside a CSV cell become spaces, because batch items are one per line. */
const flatten = (cell) => (cell ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();

export function itemsFromCsv(rows, { hasHeader, textIndex, expected }, max = MAX_ITEMS) {
  const items = [];
  let total = 0;
  for (const row of hasHeader ? rows.slice(1) : rows) {
    const text = flatten(row[textIndex]);
    if (!text) continue;
    total++;
    if (items.length >= max) continue;
    const exp = {};
    for (const [id, col] of Object.entries(expected)) {
      const value = (row[col] ?? '').trim();
      if (value) exp[id] = value;
    }
    items.push({ text, expected: exp });
  }
  return { items, truncated: total > max, total };
}

/** Re-attach imported expected answers to edited text lines, matching by identical text (duplicates match in order). */
export function applyExpected(items, imported) {
  const pool = new Map();
  for (const item of imported ?? []) {
    if (!pool.has(item.text)) pool.set(item.text, []);
    pool.get(item.text).push(item.expected ?? {});
  }
  return items.map((item) => ({ ...item, expected: pool.get(item.text)?.shift() ?? {} }));
}

/** Run `worker(index)` for each index with at most `concurrency` in flight. Stops launching new work once aborted. */
export async function runPool(indices, worker, { concurrency = 3, signal } = {}) {
  let next = 0;
  const lane = async () => {
    while (!signal?.aborted && next < indices.length) await worker(indices[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, indices.length)) }, lane));
}

/**
 * Send one request per row and record the outcome on the row (status: ok | error | pending).
 * `send(request, signal)` must reject with an Error carrying `.status` for HTTP failures.
 * Rows that were never started, or were cancelled mid-flight, stay `pending` so a later run can resume them.
 */
export async function executeBatch({ rows, indices, requestFor, send, concurrency = 3, signal, onUpdate = () => {} }) {
  const stopper = new AbortController();
  const combined = signal ? AbortSignal.any([signal, stopper.signal]) : stopper.signal;
  let fatal = null;

  await runPool(
    indices,
    async (i) => {
      const row = rows[i];
      row.status = 'running';
      row.error = null;
      onUpdate(i);
      const started = Date.now();
      try {
        row.response = await send(requestFor(row), combined);
        row.status = 'ok';
      } catch (err) {
        delete row.response;
        if (combined.aborted && err?.name === 'AbortError') {
          row.status = 'pending';
        } else {
          row.status = 'error';
          row.error = err?.message ?? String(err);
          if (FATAL_STATUSES.has(err?.status)) {
            fatal ??= err;
            stopper.abort();
          }
        }
      }
      row.latencyMs = Date.now() - started;
      onUpdate(i);
    },
    { concurrency, signal: combined },
  );
  return { fatal };
}
