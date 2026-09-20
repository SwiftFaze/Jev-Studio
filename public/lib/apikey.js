// Checks for an API key pasted into the app. Pure, so it is unit-tested; the dialog only calls it.

export const MIN_KEY_LENGTH = 8;
export const MAX_KEY_LENGTH = 512;

/** Clean up what was pasted and refuse anything that cannot be a key. Returns `{ ok, key }` or `{ ok: false, error }`. */
export function checkKey(text) {
  // People often paste the whole header value, so accept "Bearer <key>" too.
  const key = String(text ?? '').trim().replace(/^Bearer\s+/i, '');
  if (!key) return { ok: false, error: 'Paste your API key first.' };
  if (/\s/.test(key)) return { ok: false, error: 'An API key has no spaces or line breaks. Check that you copied only the key.' };
  if (!/^[!-~]+$/.test(key)) return { ok: false, error: 'That contains characters an API key does not have. Check that you copied only the key.' };
  if (key.length < MIN_KEY_LENGTH) return { ok: false, error: 'That is too short to be an API key.' };
  if (key.length > MAX_KEY_LENGTH) return { ok: false, error: 'That is too long to be an API key.' };
  return { ok: true, key };
}

/** Enough of a key to recognise it, never enough to use it: "api••••wxyz". */
export function maskKey(key) {
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}••••${key.slice(-4)}`;
}
