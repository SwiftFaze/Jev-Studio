import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, validateRequest } from './validate.js';
import { callSystemOne } from './typesafe.js';
import { mockResponse } from './mock.js';
import { diskAssets, isPackaged, packagedAssets } from './assets.js';
import { checkKey, maskKey } from '../public/lib/apikey.js';

const MAX_BODY_BYTES = 1_000_000;
const PASSTHROUGH_STATUSES = new Set([401, 422, 429, 529]);
// Guards against DNS-rebinding: this server holds an API key, so only answer to local hostnames.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

function sendJson(res, status, payload) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body too large (1 MB max).');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Request body is not valid JSON.');
  }
}

const requireJson = (req) => /^application\/json\b/i.test(req.headers['content-type'] ?? '');

function upstreamMessage(status, body, keyFromApp = false) {
  if (status === 401) {
    return keyFromApp
      ? 'TypeSafe rejected the API key you saved (401). Replace it under API key… in the menu.'
      : 'TypeSafe rejected the API key (401). Check TYPESAFE_API_KEY.';
  }
  if (status === 429) return 'Rate limited by TypeSafe (429) after several retries. Try again shortly.';
  if (status === 529) return 'TypeSafe is overloaded (529) after several retries. Try again shortly.';
  const detail = body?.error?.message ?? body?.error ?? body?.detail ?? body?.message;
  if (!detail) return `TypeSafe returned ${status}.`;
  return `TypeSafe returned ${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
}

/**
 * Build the HTTP server. Nothing is listening until the caller runs `.listen()`.
 *
 * The API key comes from `keyStore` (the encrypted file the app writes when you save a key in the UI) or, failing
 * that, from `apiKey` (`keySource` says whether that was `.env` or the environment). A stored key wins. A key is only
 * ever sent upstream; it is never included in a response, apart from a masked hint like `ts_••••cdef`.
 */
export function createApp({
  apiKey = process.env.TYPESAFE_API_KEY,
  keySource = apiKey ? 'environment' : 'none', // where `apiKey` came from: 'environment', '.env' or 'none'
  keyStore,
  mock = false,
  endpoint = process.env.TYPESAFE_API_URL || undefined,
  fetchImpl,
  publicDir,
  assets = publicDir ? diskAssets(publicDir) : isPackaged() ? packagedAssets() : diskAssets(defaultPublicDir()),
  retryDelayMs,
} = {}) {
  const stored = () => keyStore?.read() ?? { status: 'none' };

  /** Which key would be used, and where it came from. */
  function currentKey() {
    const s = stored();
    if (s.status === 'ok') return { key: s.key, source: 'stored' };
    if (apiKey) return { key: apiKey, source: keySource };
    return { key: '', source: 'none' };
  }

  function status() {
    const { key, source } = currentKey();
    return {
      configured: mock || Boolean(key),
      mock,
      model: DEFAULT_MODEL,
      keySource: mock ? 'mock' : source,
      keyHint: source === 'stored' ? maskKey(key) : null,
      keyUnreadable: stored().status === 'unreadable',
    };
  }

  async function run(req, res) {
    if (!requireJson(req)) return sendJson(res, 415, { error: 'Content-Type must be application/json.' });

    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, err.status ?? 400, { error: err.message });
    }

    const checked = validateRequest(body);
    if (!checked.ok) return sendJson(res, 422, { error: 'Invalid request', details: checked.errors });
    const { key, source } = currentKey();
    if (!mock && !key) {
      return sendJson(res, 503, {
        error: 'No API key configured. Add one under API key… in the menu, or set TYPESAFE_API_KEY in your environment.',
      });
    }

    const started = performance.now();
    try {
      const { status: code, body: out } = mock
        ? { status: 200, body: mockResponse(checked.value) }
        : await callSystemOne(checked.value, { apiKey: key, endpoint, fetchImpl, baseDelayMs: retryDelayMs });

      if (code !== 200) {
        return sendJson(res, PASSTHROUGH_STATUSES.has(code) ? code : 502, {
          error: upstreamMessage(code, out, source === 'stored'),
          upstreamStatus: code,
        });
      }
      return sendJson(res, 200, { ...out, latencyMs: Math.round(performance.now() - started), mock });
    } catch (err) {
      const timedOut = err.name === 'TimeoutError';
      return sendJson(res, timedOut ? 504 : 502, {
        error: timedOut ? 'TypeSafe did not respond in time.' : `Could not reach the TypeSafe API: ${err.message}`,
      });
    }
  }

  /** PUT saves (encrypts) the key from the request body, DELETE forgets it. Both answer with the new status. */
  async function manageKey(req, res) {
    if (!keyStore) return sendJson(res, 501, { error: 'This build cannot store an API key.' });

    if (req.method === 'DELETE') {
      try {
        keyStore.remove();
      } catch (err) {
        return sendJson(res, 500, { error: `Could not remove the saved key: ${err.code ?? err.message}` });
      }
      return sendJson(res, 200, status());
    }

    if (!requireJson(req)) return sendJson(res, 415, { error: 'Content-Type must be application/json.' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, err.status ?? 400, { error: err.message });
    }
    const checked = checkKey(body?.key);
    if (!checked.ok) return sendJson(res, 422, { error: checked.error });
    try {
      keyStore.write(checked.key);
    } catch (err) {
      return sendJson(res, 500, { error: `Could not save the key: ${err.code ?? err.message}` });
    }
    return sendJson(res, 200, status());
  }

  async function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      return sendJson(res, 400, { error: 'Bad path.' });
    }
    rel = rel.replaceAll('\\', '/');
    if (rel.split('/').includes('..')) return sendJson(res, 403, { error: 'Forbidden.' });
    const data = await assets(rel);
    if (!data) return sendJson(res, 404, { error: 'Not found.' });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(rel)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  return http.createServer(async (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!LOCAL_HOSTS.has(host)) return sendJson(res, 403, { error: 'Forbidden host.' });

    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/status') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
      return sendJson(res, 200, status());
    }
    if (pathname === '/api/run') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
      return run(req, res);
    }
    if (pathname === '/api/key') {
      if (req.method !== 'PUT' && req.method !== 'DELETE') return sendJson(res, 405, { error: 'Method not allowed.' });
      return manageKey(req, res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    return sendJson(res, 405, { error: 'Method not allowed.' });
  });
}

// Only evaluated when running from source: the packaged build serves its UI from inside the executable.
function defaultPublicDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
}
