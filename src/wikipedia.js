import pkg from '../package.json' with { type: 'json' };
import { articleUrl, mergeTables, parseInfobox, parseTables, splitSections, splitSentences, stripSnippet, WIKI_ORIGIN } from '../public/lib/wikipedia.js';

export const API_URL = `${WIKI_ORIGIN}/w/api.php`;
// Wikimedia asks for a User-Agent that says who is calling and how to reach them, which a browser cannot set.
export const USER_AGENT = `JevStudio/${pkg.version} (https://github.com/SwiftFaze/Jev-Studio)`;
export const MAX_SEARCH_LIMIT = 20;
const MAX_QUERY_CHARS = 200;
const MAX_TITLE_CHARS = 255; // Wikipedia's own limit on a title
// Characters that cannot be in a title, and control characters.
const BAD_TITLE = /[#<>[\]{}|\u0000-\u001f\u007f]/u;
const BAD_QUERY = /[\u0000-\u001f\u007f]/u;

export class WikipediaError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'WikipediaError';
    this.status = status;
  }
}

/** Check a /api/wikipedia/search body: some text to search for, and how many results (up to 20). */
export function validateSearchRequest(body) {
  const errors = [];
  const query = typeof body?.query === 'string' ? body.query.trim().replace(/\s+/g, ' ') : '';
  if (!query) errors.push('`query` must be some text to search for.');
  else if (query.length > MAX_QUERY_CHARS) errors.push(`\`query\` must be at most ${MAX_QUERY_CHARS} characters.`);
  else if (BAD_QUERY.test(query)) errors.push('`query` must not contain control characters.');

  const limit = body?.limit ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) errors.push(`\`limit\` must be a whole number from 1 to ${MAX_SEARCH_LIMIT}.`);

  return errors.length ? { ok: false, errors } : { ok: true, value: { query, limit } };
}

/** Check a /api/wikipedia/article body: an article title. */
export function validateArticleRequest(body) {
  const title = typeof body?.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
  if (!title) return { ok: false, errors: ['`title` must be the title of an article.'] };
  if (title.length > MAX_TITLE_CHARS) return { ok: false, errors: [`\`title\` must be at most ${MAX_TITLE_CHARS} characters.`] };
  if (BAD_TITLE.test(title)) return { ok: false, errors: ['`title` must be an article title, which cannot contain # < > [ ] { } | or control characters.'] };
  return { ok: true, value: { title } };
}

/** One call to the API. Resolves with the decoded JSON, or rejects with a WikipediaError that is fit to show. */
async function callApi(params, { fetchImpl, timeoutMs }) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();

  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new WikipediaError('Wikipedia did not respond in time.', 504);
    throw new WikipediaError(`Could not reach Wikipedia: ${err.message}`);
  }
  if (res.status === 429) throw new WikipediaError('Wikipedia is limiting requests (429). Try again in a minute.', 429);
  if (!res.ok) throw new WikipediaError(`Wikipedia returned ${res.status}.`);

  let body;
  try {
    body = await res.json();
  } catch {
    throw new WikipediaError('Wikipedia sent a reply that could not be read.');
  }
  return body;
}

const apiProblem = (body) => (body?.error ? new WikipediaError(`Wikipedia said: ${body.error.info ?? body.error.code ?? 'an error'}.`) : null);

/**
 * Search Wikipedia's articles. Resolves with `{ results: [{ title, snippet }] }`, best first, the snippet as plain text
 * (the highlighting Wikipedia adds is removed). An empty list is not an error.
 */
export async function searchWikipedia({ query, limit }, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const body = await callApi({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), srnamespace: '0', srprop: 'snippet' }, { fetchImpl, timeoutMs });
  const problem = apiProblem(body);
  if (problem) throw problem;
  const found = Array.isArray(body?.query?.search) ? body.query.search : [];
  return { results: found.filter((r) => typeof r?.title === 'string').map((r) => ({ title: r.title, snippet: stripSnippet(r.snippet) })) };
}

/**
 * Read one article as text. Two calls, one after the other: the plain-text extract (the whole article with its
 * headings, which leaves out the infobox and every table), then the article as HTML, for the infobox and the tables.
 * Redirects are followed. Resolves with:
 *  - `title` and `url`: the article the title led to;
 *  - `disambiguation`: true for a page that only lists other articles, so there is nothing on it to read;
 *  - `infobox`: `[{ label, value }]`, text only;
 *  - `sections`: `[{ path, anchor, sentences, tables }]`, the lead first. `tables` is `[{ caption, headers, rows }]`, a row being
 *    one line of text; a section that is only a table (no text) is there too, which the plain text alone would have missed.
 * Nothing from Wikipedia's HTML is passed on, only text taken out of it.
 */
export async function fetchArticle({ title }, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const extract = await callApi(
    { action: 'query', prop: 'extracts|pageprops', ppprop: 'disambiguation', explaintext: '1', exsectionformat: 'wiki', titles: title, redirects: '1' },
    { fetchImpl, timeoutMs },
  );
  const problem = apiProblem(extract);
  if (problem) throw problem;
  const page = extract?.query?.pages?.[0];
  if (!page || page.missing || page.invalid || typeof page.extract !== 'string') throw new WikipediaError(`There is no Wikipedia article called "${title}".`, 404);

  const resolved = page.title;
  const disambiguation = page.pageprops?.disambiguation !== undefined;
  const prose = splitSections(page.extract).map((s) => ({ path: s.path, anchor: s.anchor, sentences: splitSentences(s.text) }));
  const url = articleUrl(resolved);
  const keep = (sections) => sections.filter((s) => s.sentences.length > 0 || s.tables.length > 0);
  if (disambiguation) return { title: resolved, url, disambiguation, infobox: [], sections: keep(mergeTables(prose)) };

  // The infobox and the tables are only in the HTML. If Wikipedia cannot parse the article, it is still worth reading as text.
  const parsed = await callApi({ action: 'parse', page: resolved, prop: 'text', redirects: '1', disablelimitreport: '1', disableeditsection: '1', disabletoc: '1' }, { fetchImpl, timeoutMs });
  const html = parsed?.error ? '' : parsed?.parse?.text;
  const sections = keep(mergeTables(prose, parseTables(html)));
  return { title: resolved, url, disambiguation, infobox: parseInfobox(html), sections };
}
