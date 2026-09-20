import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createKeyStore } from '../src/keystore.js';
import { callSystemOne } from '../src/typesafe.js';
import { mockResponse } from '../src/mock.js';
import { TEMPLATES } from '../public/templates.js';

/** A real encrypted key store in a throwaway folder (fixed secret, so no machine lookups). */
function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-keystore-'));
  return { store: createKeyStore({ dir, secret: 'test-secret' }), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const putKey = (base, key) =>
  fetch(`${base}/api/key`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });

const goodBody = () => ({
  state: 'hi',
  questions: { urgent: { type: 'noul', instructions: 'Urgent?' } },
});

const upstreamOk = { model: 'jev-1.13.0', answers: { urgent: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } };
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status });

async function withServer(options, fn) {
  const server = createApp({ retryDelayMs: 1, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(`${base}/api/run`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

// fetch() will not let us spoof Host, so use raw http for the guard tests.
const rawGet = (port, path, host) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers: host ? { Host: host } : {} }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });

test('status reports whether a key is configured', async () => {
  await withServer({ apiKey: '' }, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), {
      configured: false,
      mock: false,
      model: 'jev-latest',
      keySource: 'none',
      keyHint: null,
      keyUnreadable: false,
    });
  });
  await withServer({ apiKey: 'k' }, async (base) => {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.configured, true);
    assert.equal(status.keySource, 'environment');
  });
  await withServer({ apiKey: 'k', keySource: '.env' }, async (base) => {
    const text = await (await fetch(`${base}/api/status`)).text();
    assert.equal(JSON.parse(text).keySource, '.env');
    assert.equal(text.includes('"k"'), false, 'status must never expose the key');
  });
});

test('503 with guidance when no key is configured', async () => {
  await withServer({ apiKey: '' }, async (base) => {
    const res = await post(base, goodBody());
    assert.equal(res.status, 503);
    const { error } = await res.json();
    assert.match(error, /TYPESAFE_API_KEY/);
    assert.match(error, /API key…/, 'points at the in-app option too');
  });
});

test('a key saved through /api/key is stored encrypted, used for requests, and never sent back', async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => (seen.push(init.headers.Authorization), jsonResponse(200, upstreamOk));
  const { store, dir, cleanup } = tempStore();
  try {
    await withServer({ apiKey: '', keyStore: store, fetchImpl }, async (base) => {
      const saved = await putKey(base, 'Bearer ts_live_0123456789abcdef');
      const text = await saved.text();
      assert.equal(saved.status, 200);
      assert.deepEqual(JSON.parse(text), {
        configured: true, mock: false, model: 'jev-latest', keySource: 'stored', keyHint: 'ts_\u2022\u2022\u2022\u2022cdef', keyUnreadable: false,
      });
      assert.equal(text.includes('0123456789'), false, 'only the masked hint comes back');

      assert.equal((await post(base, goodBody())).status, 200, 'works with no key in the environment');
      const status = await (await fetch(`${base}/api/status`)).text();
      assert.equal(status.includes('0123456789'), false, 'status never exposes the key');
    });
    assert.deepEqual(seen, ['Bearer ts_live_0123456789abcdef'], 'a pasted "Bearer " prefix is dropped');

    // A new server on the same folder finds the key again: it survived a restart.
    await withServer({ apiKey: '', keyStore: createKeyStore({ dir, secret: 'test-secret' }), fetchImpl }, async (base) => {
      assert.equal((await (await fetch(`${base}/api/status`)).json()).keySource, 'stored');
    });
  } finally {
    cleanup();
  }
});

test('a saved key wins over the environment key, and removing it falls back to the environment', async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => (seen.push(init.headers.Authorization), jsonResponse(200, upstreamOk));
  const { store, cleanup } = tempStore();
  try {
    await withServer({ apiKey: 'env-key-value', keySource: 'environment', keyStore: store, fetchImpl }, async (base) => {
      await post(base, goodBody());
      await putKey(base, 'saved-key-value');
      await post(base, goodBody());
      const removed = await fetch(`${base}/api/key`, { method: 'DELETE' });
      assert.equal((await removed.json()).keySource, 'environment');
      await post(base, goodBody());
    });
  } finally {
    cleanup();
  }
  assert.deepEqual(seen, ['Bearer env-key-value', 'Bearer saved-key-value', 'Bearer env-key-value']);
});

test('a malformed key is refused before anything is stored or sent, and is not echoed', async () => {
  const { store, cleanup } = tempStore();
  try {
    await withServer({ apiKey: '', keyStore: store }, async (base) => {
      for (const key of ['short', 'has spaces in it', 'a'.repeat(513), 'caf\u00e9-key-value', '', null, 5]) {
        const res = await putKey(base, key);
        assert.equal(res.status, 422, String(key).slice(0, 12));
        assert.equal((await res.text()).includes('a'.repeat(20)), false, 'the bad key is not echoed');
      }
      assert.equal(store.read().status, 'none', 'nothing was written');
      assert.equal((await fetch(`${base}/api/key`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
      assert.equal((await fetch(`${base}/api/key`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{nope' })).status, 400);
      assert.equal((await fetch(`${base}/api/key`)).status, 405);
    });
  } finally {
    cleanup();
  }
});

test('/api/key answers 501 when the app has no key store', async () => {
  await withServer({ apiKey: '' }, async (base) => {
    assert.equal((await putKey(base, 'some-key-value')).status, 501);
  });
});

test('a stored key that cannot be decrypted here is reported, not used, and can be replaced', async () => {
  const { dir, cleanup } = tempStore();
  try {
    createKeyStore({ dir, secret: 'another-machine' }).write('old-key-value');
    const seen = [];
    const fetchImpl = async (_url, init) => (seen.push(init.headers.Authorization), jsonResponse(200, upstreamOk));
    await withServer({ apiKey: 'env-key-value', keySource: 'environment', keyStore: createKeyStore({ dir, secret: 'this-machine' }), fetchImpl }, async (base) => {
      const status = await (await fetch(`${base}/api/status`)).json();
      assert.equal(status.keyUnreadable, true);
      assert.equal(status.keySource, 'environment', 'falls back to the environment key');
      await post(base, goodBody());
      assert.equal((await putKey(base, 'new-key-value')).status, 200);
      const after = await (await fetch(`${base}/api/status`)).json();
      assert.deepEqual([after.keySource, after.keyUnreadable], ['stored', false]);
    });
    assert.deepEqual(seen, ['Bearer env-key-value']);
  } finally {
    cleanup();
  }
});

test('mock mode needs no key, and status reports it as mock', async () => {
  await withServer({ mock: true }, async (base) => {
    const res = await post(base, goodBody());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mock, true);
    assert.equal((await (await fetch(`${base}/api/status`)).json()).keySource, 'mock');
  });
});

test('422 lists validation problems before touching upstream', async () => {
  let called = false;
  const fetchImpl = async () => ((called = true), jsonResponse(200, upstreamOk));
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const res = await post(base, { state: 5, questions: {} });
    assert.equal(res.status, 422);
    assert.ok((await res.json()).details.length >= 2);
    assert.equal(called, false);
  });
});

test('415 for non-JSON content types (blocks cross-site simple POSTs)', async () => {
  await withServer({ apiKey: 'k' }, async (base) => {
    const res = await post(base, JSON.stringify(goodBody()), { 'Content-Type': 'text/plain' });
    assert.equal(res.status, 415);
  });
});

test('400 for malformed JSON, 413 for oversized bodies', async () => {
  await withServer({ apiKey: 'k' }, async (base) => {
    assert.equal((await post(base, '{nope')).status, 400);
    const big = JSON.stringify({ state: 'x'.repeat(1_100_000) });
    const res = await post(base, big).catch(() => null);
    // The server may reset the connection after replying; either outcome means it refused the body.
    assert.ok(res === null || res.status === 413);
  });
});

test('forwards to upstream with the bearer key and returns answers plus latency', async () => {
  let seen;
  const fetchImpl = async (url, init) => ((seen = { url, init }), jsonResponse(200, upstreamOk));
  await withServer({ apiKey: 'secret-key', fetchImpl }, async (base) => {
    const res = await post(base, goodBody());
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.answers.urgent.noul, 0.9);
    assert.equal(typeof data.latencyMs, 'number');
    assert.equal(seen.init.headers.Authorization, 'Bearer secret-key');
    assert.equal(JSON.parse(seen.init.body).model, 'jev-latest');
    assert.equal(JSON.stringify(data).includes('secret-key'), false);
  });
});

test('a request with no input is forwarded with state: null, not rejected', async () => {
  const sent = [];
  const fetchImpl = async (_url, init) => (sent.push(JSON.parse(init.body)), jsonResponse(200, upstreamOk));
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    for (const body of [
      { state: '', questions: goodBody().questions },
      { state: null, questions: goodBody().questions },
      { questions: goodBody().questions },
    ]) {
      const res = await post(base, body);
      assert.equal(res.status, 200, JSON.stringify(body));
    }
    assert.equal(sent.length, 3);
    for (const payload of sent) {
      assert.ok('state' in payload, 'the state key is always sent');
      assert.equal(payload.state, null);
    }
  });
});

test('mock mode answers questions that have no input', async () => {
  await withServer({ mock: true }, async (base) => {
    const data = await (await post(base, { questions: goodBody().questions })).json();
    assert.equal(data.answers.urgent.type, 'noul');
  });
});

test('upstream 401 is surfaced without leaking the key', async () => {
  const fetchImpl = async () => jsonResponse(401, { error: 'bad key' });
  await withServer({ apiKey: 'secret-key', fetchImpl }, async (base) => {
    const res = await post(base, goodBody());
    const text = await res.text();
    assert.equal(res.status, 401);
    assert.match(text, /rejected the API key/);
    assert.match(text, /TYPESAFE_API_KEY/, 'a rejected environment key points at the environment setting');
    assert.equal(text.includes('secret-key'), false);
  });
  const { store, cleanup } = tempStore();
  try {
    await withServer({ apiKey: '', keyStore: store, fetchImpl }, async (base) => {
      await putKey(base, 'typed-in-app-key');
      const res = await post(base, goodBody());
      const text = await res.text();
      assert.equal(res.status, 401);
      assert.match(text, /you saved/, 'a rejected saved key points at the dialog, not at the environment');
      assert.equal(text.includes('typed-in-app-key'), false);
    });
  } finally {
    cleanup();
  }
});

test('unexpected upstream failures become 502; network errors become 502', async () => {
  await withServer({ apiKey: 'k', fetchImpl: async () => jsonResponse(500, { error: 'boom' }) }, async (base) => {
    const res = await post(base, goodBody());
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /500: boom/);
  });
  await withServer({ apiKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } }, async (base) => {
    const res = await post(base, goodBody());
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /ECONNRESET/);
  });
});

test('callSystemOne retries 429/529 with backoff, then succeeds', async () => {
  const statuses = [429, 529, 200];
  let calls = 0;
  const fetchImpl = async () => {
    const status = statuses[calls++];
    return jsonResponse(status, status === 200 ? upstreamOk : { error: 'slow down' });
  };
  const res = await callSystemOne(goodBody(), { apiKey: 'k', fetchImpl, baseDelayMs: 1 });
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
});

test('callSystemOne gives up after maxRetries and returns the last status', async () => {
  let calls = 0;
  const fetchImpl = async () => ((calls++, jsonResponse(429, { error: 'no' })));
  const res = await callSystemOne(goodBody(), { apiKey: 'k', fetchImpl, baseDelayMs: 1, maxRetries: 2 });
  assert.equal(res.status, 429);
  assert.equal(calls, 3);
});

test('non-JSON upstream bodies do not crash the proxy', async () => {
  const fetchImpl = async () => new Response('<html>gateway</html>', { status: 502 });
  const res = await callSystemOne(goodBody(), { apiKey: 'k', fetchImpl });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /gateway/);
});

test('mock mode answers every template in the real response shape', async () => {
  await withServer({ mock: true }, async (base) => {
    for (const tpl of TEMPLATES) {
      const data = await (await post(base, { ...tpl.request })).json();
      assert.equal(data.mock, true, tpl.name);
      for (const [id, q] of Object.entries(tpl.request.questions)) {
        const a = data.answers[id];
        assert.equal(a.type, q.type, `${tpl.name}/${id}`);
        if (q.type === 'noul') assert.ok(a.noul >= 0 && a.noul <= 1);
        if (q.type === 'choice') assert.ok(a.choice in q.criteria);
        if (q.type === 'score') assert.ok(a.score >= 0 && a.score <= q.criteria.length - 1);
      }
    }
  });
});

test('mock answers are deterministic for the same input', () => {
  const body = goodBody();
  assert.deepEqual(mockResponse(body), mockResponse(body));
});

test('rejects non-local Host headers (DNS rebinding guard)', async () => {
  await withServer({ apiKey: 'k' }, async (_base, port) => {
    assert.equal(await rawGet(port, '/api/status', 'evil.example.com'), 403);
    assert.equal(await rawGet(port, '/api/status', `localhost:${port}`), 200);
  });
});

test('serves the app and blocks path traversal', async () => {
  await withServer({ apiKey: 'k' }, async (base, port) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Jev Studio/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type').startsWith('text/javascript'), true);
    assert.equal((await fetch(`${base}/nope.js`)).status, 404);
    assert.equal(await rawGet(port, '/..%2fpackage.json'), 403);
    assert.equal(await rawGet(port, '/%2e%2e%2fsrc%2fserver.js'), 403);
  });
});
