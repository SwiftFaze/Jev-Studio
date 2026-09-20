export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

// 429 and 529 are documented as retry-with-backoff statuses.
const RETRYABLE_STATUSES = new Set([429, 529]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST a System One request. Retries 429/529 with exponential backoff.
 * Resolves with `{ status, body }` for any HTTP response; rejects only on network failure or timeout.
 */
export async function callSystemOne(
  payload,
  { apiKey, endpoint = DEFAULT_ENDPOINT, fetchImpl = fetch, maxRetries = 3, baseDelayMs = 500, timeoutMs = 60_000 },
) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
      await sleep(baseDelayMs * 2 ** attempt);
      continue;
    }

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 500) };
    }
    return { status: res.status, body };
  }
}
