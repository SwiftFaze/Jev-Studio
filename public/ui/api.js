import { recordUsage } from './state.js';

export class ApiError extends Error {
  constructor(message, { status = 0, details = [] } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/** Call the local server and return its JSON; rejects with ApiError (or AbortError) when it fails. */
async function call(url, init, signal) {
  let res;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(`Could not reach the local server: ${err.message}`, { status: 0 });
  }
  const data = await res.json().catch(() => ({ error: `Unexpected response from the server (${res.status}).` }));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status}).`, { status: res.status, details: data.details });
  return data;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** POST a System One request. The server adds the API key itself; the browser never holds it. */
export async function postRun(request, signal) {
  const data = await call('/api/run', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(request) }, signal);
  recordUsage(data.usage);
  return data;
}

/** Hand a pasted API key to the server, which encrypts and stores it. Resolves with the new status. */
export const saveKey = (key) => call('/api/key', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ key }) });

/** Ask the server to forget the stored key. Resolves with the new status. */
export const forgetKey = () => call('/api/key', { method: 'DELETE' });

export const fetchStatus = () => call('/api/status');
