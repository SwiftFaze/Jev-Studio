import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createKeyStore } from '../src/keystore.js';
import { callSystemOne } from '../src/typesafe.js';
import { mockResponse } from '../src/mock.js';
import { TEMPLATES } from '../public/templates.js';
import pkg from '../package.json' with { type: 'json' };

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

// fetch() refuses to connect to these ports ("bad port"). The operating system picks a free one at random, and on a machine
// whose dynamic range starts low that can be one of these, so a run would fail now and then for no reason: pick again.
const FETCH_BLOCKED_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

async function withServer(options, fn) {
  const server = createApp({ retryDelayMs: 1, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  while (FETCH_BLOCKED_PORTS.has(server.address().port)) {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
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

test('a request with no input is forwarded with state: "" (the API rejects null), not rejected', async () => {
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
      assert.equal(payload.state, '', 'the upstream API requires state and 422s on null');
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

/* ---------- Steam reviews ---------- */

const steamPost = (base, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(`${base}/api/steam/reviews`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

const steamReview = (id, text, extra = {}) => ({
  recommendationid: String(id),
  review: text,
  voted_up: true,
  votes_up: 3,
  timestamp_created: 1_700_000_000,
  author: { steamid: '76561198000000000', personaname: 'Someone Real', profile_url: 'https://steamcommunity.com/id/someone', playtime_at_review: 90, playtime_forever: 600, playtime_last_two_weeks: 120 },
  ...extra,
});
const steamSummary = { review_score_desc: 'Very Positive', total_positive: 90, total_negative: 10, total_reviews: 100 };
const steamPage = (reviews, cursor) => ({ success: 1, query_summary: steamSummary, reviews, cursor });

/** A fake Steam that serves `pages` in order and records every request it gets. */
function fakeSteam(pages) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: new URL(url), init });
    return jsonResponse(200, pages[seen.length - 1] ?? steamPage([], '*'));
  };
  return { fetchImpl, seen };
}

test('reads reviews page by page, follows the cursor (encoded), skips repeats and reviews with no text, and stops at the count', async () => {
  const { fetchImpl, seen } = fakeSteam([
    steamPage([steamReview(1, 'Great game'), steamReview(2, '   '), steamReview(3, '[b]Bad[/b] performance')], 'AoJ4+/=='),
    steamPage([steamReview(3, 'again'), steamReview(4, 'Fine'), steamReview(5, 'Too far')], 'next'),
  ]);
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const res = await steamPost(base, { app: 'https://store.steampowered.com/app/548430/Deep_Rock_Galactic/', count: 3, sort: 'helpful' });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.appId, '548430');
    assert.equal(body.name, 'Deep Rock Galactic');
    assert.deepEqual(body.summary, { scoreDesc: 'Very Positive', totalPositive: 90, totalNegative: 10, totalReviews: 100 });
    assert.deepEqual(body.reviews.map((r) => [r.id, r.text]), [['1', 'Great game'], ['3', 'Bad performance'], ['4', 'Fine']], 'the empty one and the repeat are gone, markup is cleaned, and it stops at 3');
    assert.deepEqual(body.reviews[0], { id: '1', text: 'Great game', votedUp: true, hoursTotal: 10, hoursAtReview: 1.5, hoursRecent: 2, votesUp: 3, refunded: false, freeCopy: false, earlyAccess: false, steamDeck: false, created: 1_700_000_000 });

    assert.equal(seen.length, 2, 'it did not ask for a third page once it had enough');
    assert.equal(seen[0].url.searchParams.get('cursor'), '*');
    assert.equal(seen[1].url.searchParams.get('cursor'), 'AoJ4+/==', 'the cursor survives being encoded into the URL');
    assert.equal(seen[0].url.searchParams.get('filter'), 'all', "most helpful is Steam's `all`");
    assert.equal(seen[0].url.searchParams.get('language'), 'all');
    assert.equal(seen[0].url.searchParams.get('num_per_page'), '3', 'asks for as many as are needed, not a full page');
    assert.equal(seen[1].url.searchParams.get('num_per_page'), '1', 'then only the one still missing');
    assert.equal(body.cursor, 'next');
    assert.equal(body.done, false);
  });
});

test('stops when Steam runs out of reviews, or hands back the same cursor', async () => {
  const stops = [
    fakeSteam([steamPage([steamReview(1, 'one')], 'c1'), steamPage([], 'c2')]),
    fakeSteam([steamPage([steamReview(1, 'one')], '*')]), // the cursor did not move
  ];
  for (const { fetchImpl, seen } of stops) {
    await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
      const body = await (await steamPost(base, { app: '548430', count: 50 })).json();
      assert.deepEqual(body.reviews.map((r) => r.id), ['1']);
      assert.equal(body.done, true, 'Steam has no more, so there is nothing to carry on to');
      assert.ok(seen.length <= 2);
    });
  }
});

test('an app with no reviews is an answer, not an error (Steam accepts any app id)', async () => {
  const empty = { success: 1, query_summary: { review_score_desc: 'No user reviews', total_positive: 0, total_negative: 0, total_reviews: 0 }, reviews: [], cursor: '*' };
  await withServer({ apiKey: 'k', fetchImpl: async () => jsonResponse(200, empty) }, async (base) => {
    const res = await steamPost(base, { app: '999999999' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.reviews, []);
    assert.equal(body.summary.totalReviews, 0);
  });
});

test('only the app id reaches Steam: the request goes to the reviews endpoint whatever the pasted link said', async () => {
  const { fetchImpl, seen } = fakeSteam([steamPage([steamReview(1, 'hi')], '*')]);
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const link = 'https://store.steampowered.com/app/548430/x%2F..%2F..%2Fadmin/?next=https://evil.example/steal#frag';
    assert.equal((await steamPost(base, { app: link })).status, 200);
    assert.equal(seen[0].url.origin, 'https://store.steampowered.com');
    assert.equal(seen[0].url.pathname, '/appreviews/548430');
    assert.ok(![...seen[0].url.searchParams.values()].some((v) => v.includes('evil')), 'nothing from the pasted link is forwarded');
  });
});

test('links that are not Steam apps, and bad options, are refused with 422 before Steam is contacted', async () => {
  let called = false;
  const fetchImpl = async () => ((called = true), jsonResponse(200, steamPage([], '*')));
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    for (const body of [
      {},
      { app: 'https://evil.example/app/548430/x' },
      { app: 'https://store.steampowered.com.evil.example/app/548430/' },
      { app: 'not a link' },
      { app: '548430', count: 0 },
      { app: '548430', count: 501 },
      { app: '548430', count: 2.5 },
      { app: '548430', count: '100' },
      { app: '548430', sort: 'oldest' },
      { app: '548430', sort: '__proto__' },
    ]) {
      const res = await steamPost(base, body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.ok((await res.json()).details.length > 0);
    }
  });
  assert.equal(called, false);
});

test("the TypeSafe key is never sent to Steam, and the reviewer's name and profile are not passed on", async () => {
  const { fetchImpl, seen } = fakeSteam([steamPage([steamReview(1, 'hi')], '*')]);
  await withServer({ apiKey: 'secret-key-value', fetchImpl }, async (base) => {
    const res = await steamPost(base, { app: '548430' });
    const text = await res.text();
    assert.doesNotMatch(JSON.stringify(seen[0].init.headers), /secret-key-value|authorization/i);
    assert.doesNotMatch(String(seen[0].url), /secret-key-value/);
    assert.doesNotMatch(text, /Someone Real|76561198000000000|steamcommunity\.com\/id/);
  });
});

test('reading Steam reviews needs no API key, and works in mock mode', async () => {
  for (const options of [{ apiKey: '' }, { apiKey: '', mock: true }]) {
    const { fetchImpl } = fakeSteam([steamPage([steamReview(1, 'hi')], '*')]);
    await withServer({ ...options, fetchImpl }, async (base) => {
      const res = await steamPost(base, { app: '548430' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).reviews.length, 1);
    });
  }
});

test('Steam problems become readable errors: rate limit 429, other statuses 502, unreadable or unsuccessful replies 502, network 502, timeout 504', async () => {
  const cases = [
    [async () => jsonResponse(429, {}), 429, /limiting requests/],
    [async () => jsonResponse(500, {}), 502, /Steam returned 500/],
    [async () => new Response('<html>oops</html>', { status: 200 }), 502, /could not be read/],
    [async () => jsonResponse(200, { success: 0 }), 502, /could not return reviews/],
    [async () => { throw new Error('ECONNRESET'); }, 502, /Could not reach Steam: ECONNRESET/],
    [async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, 504, /did not respond in time/],
  ];
  for (const [fetchImpl, status, message] of cases) {
    await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
      const res = await steamPost(base, { app: '548430' });
      assert.equal(res.status, status, String(message));
      assert.match((await res.json()).error, message);
    });
  }
});

test('/api/steam/reviews is POST with JSON only: a GET is 405, other content types 415, bad JSON 400', async () => {
  await withServer({ apiKey: 'k', fetchImpl: async () => jsonResponse(200, steamPage([], '*')) }, async (base) => {
    assert.equal((await fetch(`${base}/api/steam/reviews`)).status, 405);
    assert.equal((await steamPost(base, { app: '548430' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await steamPost(base, '{nope')).status, 400);
  });
});

/** A fake Steam that serves its reviews by cursor, as the real one does: `pages` maps a cursor to the page it returns. */
function steamByCursor(pages) {
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    seen.push({ cursor: u.searchParams.get('cursor'), perPage: u.searchParams.get('num_per_page') });
    return jsonResponse(200, pages[u.searchParams.get('cursor')] ?? steamPage([], u.searchParams.get('cursor')));
  };
  return { fetchImpl, seen };
}

test('reading in batches: each starts from the cursor the last one gave, with nothing lost or repeated, and only the first page has Steam\'s totals', async () => {
  const { fetchImpl, seen } = steamByCursor({
    '*': steamPage([steamReview(1, 'one'), steamReview(2, 'two'), steamReview(3, 'three')], 'c1'),
    c1: { success: 1, query_summary: { num_reviews: 3 }, reviews: [steamReview(4, 'four'), steamReview(5, 'five'), steamReview(6, 'six')], cursor: 'c2' },
    c2: { success: 1, query_summary: { num_reviews: 0 }, reviews: [], cursor: 'c2' },
  });
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const first = await (await steamPost(base, { app: '548430', count: 3 })).json();
    assert.deepEqual(first.reviews.map((r) => r.id), ['1', '2', '3']);
    assert.equal(first.cursor, 'c1');
    assert.equal(first.done, false);
    assert.equal(first.summary.totalReviews, 100);

    const second = await (await steamPost(base, { app: '548430', count: 3, cursor: first.cursor })).json();
    assert.deepEqual(second.reviews.map((r) => r.id), ['4', '5', '6']);
    assert.equal(second.cursor, 'c2');
    assert.equal(second.done, false);
    assert.equal(second.summary, null, 'Steam sends its totals with the first page only, so a later batch has none rather than zeros');

    const third = await (await steamPost(base, { app: '548430', count: 3, cursor: second.cursor })).json();
    assert.deepEqual(third.reviews, []);
    assert.equal(third.done, true, 'nothing after the last review');
  });
  assert.deepEqual(seen.map((s) => s.cursor), ['*', 'c1', 'c2']);
});

test('each page asks Steam for only as many reviews as are still needed, and never more than 100, so a batch ends exactly where the next begins', async () => {
  let next = 0;
  const seen = [];
  const fetchImpl = async (url) => {
    const perPage = Number(new URL(url).searchParams.get('num_per_page'));
    seen.push(perPage);
    return jsonResponse(200, steamPage(Array.from({ length: perPage }, () => steamReview(++next, `review ${next}`)), `after-${next}`));
  };
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const body = await (await steamPost(base, { app: '548430', count: 250 })).json();
    assert.equal(body.reviews.length, 250);
    assert.equal(body.cursor, 'after-250', 'the cursor is the one after the last review that was returned');
    assert.equal(body.done, false);
  });
  assert.deepEqual(seen, [100, 100, 50]);
});

test('a batch of the biggest size is allowed, one more is not', async () => {
  const { fetchImpl } = fakeSteam([steamPage([steamReview(1, 'hi')], '*')]);
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    assert.equal((await steamPost(base, { app: '548430', count: 500 })).status, 200);
    assert.equal((await steamPost(base, { app: '548430', count: 501 })).status, 422);
  });
});

test('a cursor that could not have come from Steam is refused before anything is sent to it', async () => {
  let called = false;
  const fetchImpl = async () => ((called = true), jsonResponse(200, steamPage([], '*')));
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    for (const cursor of ['a b', 'x'.repeat(301), 5, '<script>', '../../etc', '', '?a=1&b=2', 'a\nb', null && 'x']) {
      if (cursor == null) continue;
      const res = await steamPost(base, { app: '548430', cursor });
      assert.equal(res.status, 422, JSON.stringify(cursor));
      assert.match((await res.json()).details.join(' '), /cursor/);
    }
  });
  assert.equal(called, false);
});

test('a real-looking cursor, with the characters Steam uses, is passed through untouched', async () => {
  const { fetchImpl, seen } = steamByCursor({ 'AoJ4zb/z36ADe9WSgwc=': steamPage([steamReview(1, 'hi')], 'AoJ4zb/z36ADe9WSgxx=') });
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const body = await (await steamPost(base, { app: '548430', count: 1, cursor: 'AoJ4zb/z36ADe9WSgwc=' })).json();
    assert.equal(body.cursor, 'AoJ4zb/z36ADe9WSgxx=');
  });
  assert.equal(seen[0].cursor, 'AoJ4zb/z36ADe9WSgwc=');
});

test('reviews are always read in every language, whatever a request says', async () => {
  const { fetchImpl, seen } = fakeSteam([steamPage([steamReview(1, 'hi')], '*')]);
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    assert.equal((await steamPost(base, { app: '548430', language: 'english' })).status, 200, 'an old client that still sends one is not an error');
    assert.equal((await steamPost(base, { app: '548430', language: 'https://evil.example' })).status, 200);
  });
  for (const request of seen) assert.equal(request.url.searchParams.get('language'), 'all');
});

test("each review keeps the facts Jev is told, mapped from Steam's own fields, and nothing else", async () => {
  const rich = steamReview(7, 'Runs great on my deck', {
    voted_up: false,
    votes_up: 41,
    weighted_vote_score: '0.93',
    refunded: true,
    received_for_free: true,
    written_during_early_access: true,
    primarily_steam_deck: true,
    steam_purchase: true,
    votes_funny: 9,
    author: { steamid: '76561198000000000', personaname: 'Someone Real', playtime_forever: 90_000, playtime_at_review: 6_000, playtime_last_two_weeks: 0, num_games_owned: 400 },
  });
  const bare = steamReview(8, 'ok', { author: {} }); // Steam gave no playtime at all
  const { fetchImpl } = fakeSteam([steamPage([rich, bare], 'next')]);
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const res = await steamPost(base, { app: '548430', count: 2 });
    const text = await res.text();
    const [a, b] = JSON.parse(text).reviews;

    assert.deepEqual(a, { id: '7', text: 'Runs great on my deck', votedUp: false, hoursTotal: 1500, hoursAtReview: 100, hoursRecent: 0, votesUp: 41, refunded: true, freeCopy: true, earlyAccess: true, steamDeck: true, created: 1_700_000_000 });
    assert.deepEqual([b.hoursTotal, b.hoursAtReview, b.hoursRecent], [null, null, null], 'playtime Steam did not report is null, not zero');
    assert.deepEqual(Object.keys(a).sort(), ['created', 'earlyAccess', 'freeCopy', 'hoursAtReview', 'hoursRecent', 'hoursTotal', 'id', 'refunded', 'steamDeck', 'text', 'votedUp', 'votesUp']);
    assert.doesNotMatch(text, /weighted|0.93|Someone Real|76561198|num_games_owned|votes_funny/, 'the rest of what Steam sends is not passed on');
  });
});

/* ---------- Wikipedia ---------- */

const wikiFixture = (name) => readFileSync(new URL(`./fixtures/wikipedia/${name}`, import.meta.url), 'utf8');
const wikiPost = (base, route, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(`${base}/api/wikipedia/${route}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const okJson = (text) => new Response(text, { status: 200 });

/** A fake Wikipedia built from the saved replies. It records every request, and answers by what was asked for. */
function fakeWikipedia({ extract = 'extract-paris.json', parse = 'parse-paris.json', search = 'search-how-big-is-paris.json' } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    seen.push({ url: u, init });
    if (u.searchParams.get('list') === 'search') return okJson(wikiFixture(search));
    if (u.searchParams.get('action') === 'parse') return okJson(wikiFixture(parse));
    return okJson(wikiFixture(extract));
  };
  return { fetchImpl, seen };
}

test('search: asks Wikipedia with a descriptive User-Agent, and returns titles with plain-text snippets', async () => {
  const { fetchImpl, seen } = fakeWikipedia();
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const res = await wikiPost(base, 'search', { query: '  how   big is paris ', limit: 5 });
    assert.equal(res.status, 200);
    const { results } = await res.json();
    assert.deepEqual(results.map((r) => r.title).slice(0, 3), ['How Big, How Blue, How Beautiful', 'Paris Is Burning (film)', 'Paris']);
    assert.match(results[2].snippet, /^Paris is the capital and largest city of France, with an estimated city population of 2\.04 million in an area of 105\.4 km2 \(40\.7 sq mi\)/);
    assert.doesNotMatch(JSON.stringify(results), /<span|searchmatch|\[update\]/);
    assert.deepEqual(Object.keys(results[0]), ['title', 'snippet'], 'nothing else Wikipedia sends is passed on');

    assert.equal(seen.length, 1);
    assert.equal(seen[0].url.origin, 'https://en.wikipedia.org');
    assert.equal(seen[0].url.pathname, '/w/api.php');
    assert.equal(seen[0].url.searchParams.get('srsearch'), 'how big is paris');
    assert.equal(seen[0].url.searchParams.get('srlimit'), '5');
    assert.equal(seen[0].init.headers['User-Agent'], `JevStudio/${pkg.version} (https://github.com/SwiftFaze/Jev-Studio)`);
  });
});

test('search: no results is an empty list, and the limit defaults to 8', async () => {
  let seenUrl;
  const fetchImpl = async (url) => ((seenUrl = new URL(url)), okJson('{"batchcomplete":true,"query":{"search":[]}}'));
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const res = await wikiPost(base, 'search', { query: 'zzzzqqqq' });
    assert.deepEqual(await res.json(), { results: [] });
    assert.equal(seenUrl.searchParams.get('srlimit'), '8');
  });
});

test('article: returns the infobox rows and the sections as sentences and tables, in two calls made one after the other', async () => {
  const { fetchImpl, seen } = fakeWikipedia();
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const res = await wikiPost(base, 'article', { title: 'Paris' });
    assert.equal(res.status, 200);
    const article = await res.json();
    assert.deepEqual(Object.keys(article).sort(), ['disambiguation', 'infobox', 'sections', 'title', 'url']);
    assert.equal(article.title, 'Paris');
    assert.equal(article.url, 'https://en.wikipedia.org/wiki/Paris');
    assert.equal(article.disambiguation, false);
    assert.equal(article.infobox.find((r) => r.label === 'Area').value, '105.4 km2 (40.7 sq mi) • Urban 2,824.2 km2 (1,090.4 sq mi) • Metro 18,940.7 km2 (7,313.0 sq mi)');
    assert.deepEqual(article.sections.map((s) => s.path).slice(0, 4), ['Lead', 'Etymology', 'Geography', 'Geography › Climate']);
    assert.equal(article.sections[3].anchor, 'Climate');
    assert.match(article.sections[0].sentences[0], /^Paris is the capital and largest city of France/);
    assert.ok(article.sections.every((s) => s.sentences.length > 0 && s.sentences.every((x) => typeof x === 'string')));
    assert.doesNotMatch(JSON.stringify(article), /<[a-z]+[ >]|&#\d+;|mw-parser-output/, "text only: none of Wikipedia's HTML is passed on");

    assert.deepEqual(seen.map((r) => r.url.searchParams.get('action')), ['query', 'parse'], 'the extract, then the infobox');
    assert.equal(seen[0].url.searchParams.get('titles'), 'Paris');
    assert.equal(seen[0].url.searchParams.get('redirects'), '1');
    assert.equal(seen[0].url.searchParams.get('explaintext'), '1');
    assert.equal(seen[1].url.searchParams.get('section'), null, 'the whole article, so that its tables are there too');
    assert.equal(seen[1].url.searchParams.get('page'), 'Paris');
    assert.equal(seen[1].url.searchParams.get('disableeditsection'), '1');
    for (const request of seen) assert.match(request.init.headers['User-Agent'], /^JevStudio\/\d+\.\d+\.\d+ \(https:\/\/github\.com\/SwiftFaze\/Jev-Studio\)$/);
  });
});

test('article: a disambiguation page is reported as one, and the infobox is not fetched for it', async () => {
  const { fetchImpl, seen } = fakeWikipedia({ extract: 'extract-mercury.json' });
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const article = await (await wikiPost(base, 'article', { title: 'Mercury' })).json();
    assert.equal(article.disambiguation, true);
    assert.deepEqual(article.infobox, []);
    assert.equal(seen.length, 1);
  });
});

test('article: a title that does not exist is a 404, and one Wikipedia cannot parse still gives the text', async () => {
  await withServer({ apiKey: 'k', fetchImpl: fakeWikipedia({ extract: 'extract-missing.json' }).fetchImpl }, async (base) => {
    const res = await wikiPost(base, 'article', { title: 'Zzzz Not A Page Qqq' });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no Wikipedia article called "Zzzz Not A Page Qqq"/);
  });
  const fetchImpl = async (url) => okJson(new URL(url).searchParams.get('action') === 'parse' ? '{"error":{"code":"missingtitle","info":"The page you specified does not exist."}}' : wikiFixture('extract-paris.json'));
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const res = await wikiPost(base, 'article', { title: 'Paris' });
    assert.equal(res.status, 200);
    const article = await res.json();
    assert.deepEqual(article.infobox, []);
    assert.ok(article.sections.length > 0);
  });
});

test('Wikipedia routes: bad bodies are refused with 422 before Wikipedia is contacted', async () => {
  let called = false;
  const fetchImpl = async () => ((called = true), okJson('{}'));
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    for (const [route, body] of [
      ['search', {}],
      ['search', { query: '' }],
      ['search', { query: '   ' }],
      ['search', { query: 42 }],
      ['search', { query: 'x'.repeat(201) }],
      ['search', { query: 'a\u0000b' }],
      ['search', { query: 'paris', limit: 0 }],
      ['search', { query: 'paris', limit: 21 }],
      ['search', { query: 'paris', limit: 2.5 }],
      ['search', { query: 'paris', limit: '5' }],
      ['article', {}],
      ['article', { title: '' }],
      ['article', { title: 7 }],
      ['article', { title: 'x'.repeat(256) }],
      ['article', { title: 'Paris|Rome' }],
      ['article', { title: 'Paris#History' }],
      ['article', { title: '<script>' }],
      ['article', { title: 'a\u0000b' }],
    ]) {
      const res = await wikiPost(base, route, body);
      assert.equal(res.status, 422, `${route} ${JSON.stringify(body)}`);
      assert.ok((await res.json()).details.length > 0);
    }
    assert.equal((await wikiPost(base, 'search', '{not json')).status, 400);
    assert.equal((await wikiPost(base, 'search', { query: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await fetch(`${base}/api/wikipedia/search`)).status, 405);
    assert.equal((await fetch(`${base}/api/wikipedia/article`, { method: 'PUT' })).status, 405);
  });
  assert.equal(called, false);
});

test('what is sent to Wikipedia is only the checked query or title, and never the TypeSafe key', async () => {
  const { fetchImpl, seen } = fakeWikipedia();
  await withServer({ apiKey: 'secret-key-value', fetchImpl }, async (base) => {
    await wikiPost(base, 'search', { query: 'paris', extra: 'https://evil.example', host: 'evil.example' });
    await wikiPost(base, 'article', { title: '../../etc/passwd' });
    assert.ok(seen.length >= 2);
    for (const request of seen) {
      assert.equal(request.url.origin, 'https://en.wikipedia.org');
      assert.doesNotMatch(JSON.stringify(request.init.headers), /secret-key-value|authorization/i);
      assert.doesNotMatch(String(request.url), /secret-key-value|evil/);
    }
  });
});

test('reading Wikipedia needs no API key, and works in mock mode', async () => {
  for (const options of [{ apiKey: '' }, { apiKey: '', mock: true }]) {
    await withServer({ ...options, fetchImpl: fakeWikipedia().fetchImpl }, async (base) => {
      assert.equal((await wikiPost(base, 'search', { query: 'paris' })).status, 200);
      assert.equal((await wikiPost(base, 'article', { title: 'Paris' })).status, 200);
    });
  }
});

test('Wikipedia problems become readable errors: 429, other statuses 502, unreadable or error replies 502, network 502, timeout 504', async () => {
  const cases = [
    [async () => new Response('{}', { status: 429 }), 429, /limiting requests/],
    [async () => new Response('{}', { status: 500 }), 502, /Wikipedia returned 500/],
    [async () => new Response('<html>oops</html>', { status: 200 }), 502, /could not be read/],
    [async () => okJson('{"error":{"code":"maxlag","info":"Waiting for a database server"}}'), 502, /Wikipedia said: Waiting for a database server/],
    [async () => { throw new Error('ECONNRESET'); }, 502, /Could not reach Wikipedia: ECONNRESET/],
    [async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, 504, /did not respond in time/],
  ];
  for (const [fetchImpl, status, message] of cases) {
    for (const [route, body] of [['search', { query: 'paris' }], ['article', { title: 'Paris' }]]) {
      await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
        const res = await wikiPost(base, route, body);
        assert.equal(res.status, status, `${route} ${message}`);
        assert.match((await res.json()).error, message);
      });
    }
  }
});

test('a 429 on the second call of an article (the infobox) is still reported, not hidden as a missing infobox', async () => {
  const fetchImpl = async (url) => (new URL(url).searchParams.get('action') === 'parse' ? new Response('{}', { status: 429 }) : okJson(wikiFixture('extract-paris.json')));
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    assert.equal((await wikiPost(base, 'article', { title: 'Paris' })).status, 429);
  });
});

test('article: a table is read a row at a time, and a section that is only a table (which the plain text leaves out) is there too', async () => {
  const { fetchImpl } = fakeWikipedia({ extract: 'extract-c4-picasso.json', parse: 'parse-c4-picasso.json' });
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const article = await (await wikiPost(base, 'article', { title: 'Citroën C4 Picasso' })).json();
    const paths = article.sections.map((s) => s.path);
    assert.ok(paths.includes('Engines'), 'the Engines section has no text, only a table, and is not in the plain text');
    assert.equal(paths.indexOf('Engines'), paths.indexOf('Second generation (2013–2022) › Transmissions') + 1, 'and it is where it is on the page');
    const engines = article.sections.find((s) => s.path === 'Engines');
    assert.deepEqual(engines.sentences, []);
    assert.equal(engines.anchor, 'Engines');
    assert.equal(engines.tables.length, 1);
    assert.equal(engines.tables[0].caption, 'Engine range and spec');
    assert.ok(engines.tables[0].headers.includes('Top speed'));
    const vti = engines.tables[0].rows.find((r) => r.includes('1.6 litre VTi 16v'));
    assert.match(vti, /Top speed: 187 km\/h \(116 mph\)/);
    assert.match(vti, /^Petrol engines — Model: 1\.6 litre VTi 16v • Years: 2006–present/);

    const sales = article.sections.find((s) => s.path === 'Sales');
    assert.ok(sales.sentences.length > 0 && sales.tables.length === 1, 'a section with text and a table has both');
    assert.equal(JSON.stringify(article).includes('Wanted'), false, 'the table under See also is left out');
    assert.doesNotMatch(JSON.stringify(article), /<[a-z]+[ >]|&#\d+;/, 'text only');
  });
});

test('article: when Wikipedia cannot parse the page, it is still read as text, with no tables', async () => {
  const fetchImpl = async (url) => okJson(new URL(url).searchParams.get('action') === 'parse' ? '{"error":{"code":"x","info":"nope"}}' : wikiFixture('extract-c4-picasso.json'));
  await withServer({ apiKey: 'k', fetchImpl }, async (base) => {
    const article = await (await wikiPost(base, 'article', { title: 'Citroën C4 Picasso' })).json();
    assert.ok(article.sections.length > 0);
    assert.ok(article.sections.every((s) => s.tables.length === 0 && s.sentences.length > 0));
    assert.deepEqual(article.infobox, []);
  });
});
