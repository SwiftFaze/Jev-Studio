import { cleanReviewText, parseSteamApp, STEAM_MAX_BATCH, STEAM_SORTS } from '../public/lib/steam.js';

export const REVIEWS_URL = 'https://store.steampowered.com/appreviews';
const PAGE_SIZE = 100; // the most Steam returns per request
// A hard stop, so a game whose reviews are mostly empty cannot keep this loop going: enough pages for the biggest
// batch, plus slack for reviews with no text.
const MAX_PAGES = Math.ceil(STEAM_MAX_BATCH / PAGE_SIZE) + 5;
// What a cursor looks like: base64 (or url-safe base64), or a lone "*" for the start. It is url-encoded into the request
// either way, but only one that looks like Steam's is sent at all.
const CURSOR = /^(?:\*|[A-Za-z0-9+/=_-]{1,300})$/;
// Steam calls "most helpful" `all` and "most recent" `recent`.
const STEAM_FILTER = { helpful: 'all', recent: 'recent' };
// Reviews are always read in every language (Steam's word for that is `all`). Steam's totals depend on it too, so it is
// one fixed choice rather than a setting.
const LANGUAGE = 'all';

export class SteamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'SteamError';
    this.status = status;
  }
}

/** Check a /api/steam/reviews body. Only the app id's digits, and values from fixed lists, go into the Steam request. */
export function validateSteamRequest(body) {
  const errors = [];
  const game = parseSteamApp(body?.app);
  if (!game) errors.push('`app` must be a Steam store link or an app id.');

  const count = body?.count ?? 100;
  if (!Number.isInteger(count) || count < 1 || count > STEAM_MAX_BATCH) errors.push(`\`count\` must be a whole number from 1 to ${STEAM_MAX_BATCH}.`);

  const sort = body?.sort ?? 'recent';
  if (!Object.hasOwn(STEAM_SORTS, sort)) errors.push(`\`sort\` must be one of ${Object.keys(STEAM_SORTS).join(', ')}.`);

  // Where to carry on from: the cursor an earlier reply gave, or "*" for the start.
  const cursor = body?.cursor ?? '*';
  if (typeof cursor !== 'string' || !CURSOR.test(cursor)) errors.push('`cursor` must be the cursor an earlier reply gave, or left out.');

  return errors.length ? { ok: false, errors } : { ok: true, value: { appId: game.appId, name: game.name, count, sort, cursor } };
}

/** Steam counts playtime in minutes. Hours to one decimal, or null when Steam did not say (which is not the same as none). */
const hours = (minutes) => (minutes == null ? null : Math.round(((Number(minutes) || 0) / 60) * 10) / 10);

/**
 * Keep what the analysis needs, and nothing else. What Steam sends about a review is a large object; Jev is shown only
 * the parts below, formatted (see buildSteamState). The reviewer's name, profile, avatar and Steam id are deliberately
 * not passed along, and neither is `weighted_vote_score`, Steam's own helpfulness ranking, which `votesUp` already covers.
 */
function normalizeReview(r) {
  const author = r.author ?? {};
  return {
    id: String(r.recommendationid),
    text: cleanReviewText(r.review),
    votedUp: r.voted_up === true, // their thumbs: kept for the accuracy check and shown to Jev only if asked
    hoursTotal: hours(author.playtime_forever), // playtime_forever: all the time they have played
    hoursAtReview: hours(author.playtime_at_review), // playtime_at_review: how much they had played when they wrote it
    hoursRecent: hours(author.playtime_last_two_weeks), // playtime_last_two_weeks: are they still playing
    votesUp: Number(r.votes_up) || 0, // how many people found the review helpful (not how many agree with its verdict)
    refunded: r.refunded === true,
    freeCopy: r.received_for_free === true,
    earlyAccess: r.written_during_early_access === true,
    steamDeck: r.primarily_steam_deck === true,
    created: Number(r.timestamp_created) || 0,
  };
}

/** Steam's totals. It sends them with the first page only, so this is null for a page read from a cursor. */
function normalizeSummary(s) {
  if (s?.total_reviews == null) return null;
  return {
    scoreDesc: typeof s.review_score_desc === 'string' ? s.review_score_desc : '',
    totalPositive: Number(s.total_positive) || 0,
    totalNegative: Number(s.total_negative) || 0,
    totalReviews: Number(s.total_reviews) || 0,
  };
}

async function fetchPage(appId, { filter, cursor, perPage }, { fetchImpl, timeoutMs }) {
  const url = new URL(`${REVIEWS_URL}/${appId}`);
  url.search = new URLSearchParams({ json: '1', filter, language: LANGUAGE, review_type: 'all', purchase_type: 'all', num_per_page: String(perPage), cursor }).toString();

  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new SteamError('Steam did not respond in time.', 504);
    throw new SteamError(`Could not reach Steam: ${err.message}`);
  }
  if (res.status === 429) throw new SteamError('Steam is limiting requests (429). Try again in a minute.', 429);
  if (!res.ok) throw new SteamError(`Steam returned ${res.status}.`);

  let body;
  try {
    body = await res.json();
  } catch {
    throw new SteamError('Steam sent a reply that could not be read.');
  }
  if (body?.success !== 1) throw new SteamError('Steam could not return reviews for that app.');
  return body;
}

/**
 * Read up to `count` written reviews of one app, following Steam's cursor from `cursor` ("*" is the start). Each page
 * asks for only as many as are still needed, so a batch ends exactly where the next one can begin. Resolves with:
 *  - `reviews`: the ones that have text (a thumbs up with no words has nothing for Jev to read);
 *  - `cursor`: where to carry on from, to pass in next time;
 *  - `done`: true once Steam has no more, so there is nothing to carry on to;
 *  - `summary`: Steam's own totals for the game (every language), or null when reading from a cursor, because Steam
 *    sends them with the first page only.
 * It may hold fewer reviews than asked for, when the game has fewer left. Steam lets any app id through with zero
 * reviews, so an empty result is not an error here.
 */
export async function fetchSteamReviews({ appId, count, sort, cursor = '*' }, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const filter = STEAM_FILTER[sort];
  const reviews = [];
  const seen = new Set(); // new reviews can push older ones onto the next page while we read, so the same one may come twice
  let summary = null;
  let next = cursor;
  let done = false;

  for (let page = 0; page < MAX_PAGES && reviews.length < count; page++) {
    const perPage = Math.min(PAGE_SIZE, count - reviews.length);
    const body = await fetchPage(appId, { filter, cursor: next, perPage }, { fetchImpl, timeoutMs });
    summary ??= normalizeSummary(body.query_summary);

    const batch = Array.isArray(body.reviews) ? body.reviews : [];
    for (const raw of batch) {
      if (reviews.length >= count) break; // Steam honours the page size, but the reply never holds more than was asked for
      const review = normalizeReview(raw);
      if (seen.has(review.id)) continue;
      seen.add(review.id);
      if (review.text) reviews.push(review);
    }
    if (batch.length === 0 || !body.cursor || body.cursor === next) {
      done = true;
      break;
    }
    next = body.cursor;
  }
  return { summary, reviews, cursor: next, done };
}
