// Steam review analysis: reading a store link, the fixed questions Jev is asked about each review, and the roll-up of
// the answers. No DOM, so it is unit-tested; the server imports it too, so both sides read a link the same way.

export const MAX_REVIEW_CHARS = 3000; // Steam allows 8000; longer text costs tokens on every one of the questions
// Reviews are read and analysed one batch at a time, each starting where the last stopped, so a game with hundreds of
// thousands of them never has to be held all at once. This is the most one request to the server returns.
export const STEAM_MAX_BATCH = 500;
export const STEAM_BATCH_SIZES = [50, 100, 200, 500];
// A first guess at what each review costs, until a batch has run and the page can use the real figure. The original six
// questions measured 1,167 tokens per review on a real 500-review run; the questions asked since add about 1,600 tokens of
// question text (a quarter of a token per character) and a short answer each, and the facts about the reviewer about 60.
export const TOKENS_PER_REVIEW = 3200;
export const STEAM_SORTS = { recent: 'Most recent', helpful: 'Most helpful' };
export const MIN_MENTIONS = 10; // a share of fewer mentions than this is anecdote: the page leaves that card out

const STORE_HOSTS = new Set(['store.steampowered.com', 'steamcommunity.com']);
// /app/548430/Deep_Rock_Galactic/ (a store page) or /appreviews/548430 (the reviews API), with or without more after it.
const APP_PATH = /^\/(?:app|appreviews)\/(\d{1,10})(?:\/([^/]*))?/i;

/** "Deep_Rock_Galactic" -> "Deep Rock Galactic". Store links carry the name; the API and a bare app id do not. */
function nameFromSlug(slug) {
  if (!slug) return null;
  let text = slug;
  try {
    text = decodeURIComponent(slug);
  } catch {
    // a malformed escape: use the slug as it is
  }
  text = text.replace(/_+/g, ' ').trim();
  return text || null;
}

const normalizeAppId = (digits) => (Number(digits) > 0 ? String(Number(digits)) : null);

/**
 * Read a Steam store link, a reviews API link, or a bare app id. Returns `{ appId, name }` (`name` is null when the
 * link does not carry one), or null when this is not a Steam app. Only the digits are ever used to build a request,
 * so a pasted link is never fetched as it was typed.
 */
export function parseSteamApp(input) {
  const text = String(input ?? '').trim();
  if (/^\d{1,10}$/.test(text)) {
    const appId = normalizeAppId(text);
    return appId ? { appId, name: null } : null;
  }

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!STORE_HOSTS.has(url.hostname.toLowerCase().replace(/^www\./, ''))) return null;

  const match = APP_PATH.exec(url.pathname);
  const appId = match && normalizeAppId(match[1]);
  return appId ? { appId, name: nameFromSlug(match[2]) } : null;
}

export const storeUrl = (appId) => `https://store.steampowered.com/app/${appId}/`;

// Steam's own markup: [b], [h1], [url=...]text[/url], [img]...[/img], and so on.
// Pictures and videos have nothing to read, so they go with their contents. Spoiler tags only hide words that may hold
// the reviewer's opinion, so only the tags go.
const MARKUP_BLOCKS = /\[(img|previewyoutube)\b[^\]]*\][\s\S]*?\[\/\1\]/gi;
const MARKUP_LINKS = /\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi;
const MARKUP_TAGS = /\[\/?(?:h[1-6]|b|i|u|s|strike|spoiler|quote(?:=[^\]]*)?|list|olist|\*|hr|code|table|tr|th|td|noparse|url)\]/gi;

/** A review as plain, single-line text: Steam markup removed, whitespace collapsed, cut to MAX_REVIEW_CHARS. */
export function cleanReviewText(raw, max = MAX_REVIEW_CHARS) {
  const text = String(raw ?? '')
    .replace(MARKUP_BLOCKS, ' ')
    .replace(MARKUP_LINKS, '$1')
    .replace(MARKUP_TAGS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/* ---------- the questions ---------- */

/** The option every Choice topic ends with: the review says nothing about it, which is what most reviews do about most topics. */
export const NOT_MENTIONED = 'not_mentioned';

/** The headings the cards are grouped under, in order. */
export const STEAM_GROUPS = [
  { id: 'overall', label: 'Overall' },
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'content', label: 'Content and value' },
  { id: 'technical', label: 'Technical' },
  { id: 'community', label: 'Community and support' },
  { id: 'compared', label: 'Compared with others' },
];

/**
 * One topic reviews can bring up. This one table is where a topic lives: the question Jev is asked and each answer it
 * can give, and how those answers add up on the summary card. Each option has a `tone` (good, bad or neutral for the
 * game), so a topic can have more than two sides ("too easy" and "too hard" are both bad).
 *
 * `headline` is the tone whose share is the card's big number, and `label` and `says` describe that side, so the
 * number always answers the card's own title: "Pay to win: 0%" means nobody says it is. Colour follows the share for
 * the game, so a low "Pay to win" is still green.
 */
const topic = (group, id, label, says, headline, question, options, absent) => ({
  group,
  id,
  label,
  says,
  headline,
  type: 'choice',
  question,
  options: options.map(([key, tone, name, note]) => ({ key, tone, label: name, note })),
  absent,
});

export const STEAM_TOPICS = [
  {
    group: 'overall',
    id: 'positive',
    label: 'Positive',
    says: 'are positive about the game',
    headline: 'good',
    type: 'noul',
    question: 'Is the reviewer positive about the game overall?',
    options: [
      { key: 'yes', tone: 'good', label: 'Positive', note: 'The reviewer enjoys the game or recommends it' },
      { key: 'no', tone: 'bad', label: 'Negative', note: 'The reviewer dislikes the game or advises against it' },
    ],
    absent: null,
  },
  topic('overall', 'worth_price', 'Worth the price', 'say it is worth the price', 'good', 'What does the reviewer say about whether the game is worth its price?', [
    ['worth_it', 'good', 'Worth it', 'Says it is good value, or worth what it costs'],
    ['not_worth_it', 'bad', 'Not worth it', 'Says it is overpriced, or not worth what it costs'],
  ], 'Does not discuss price or value'),
  topic('overall', 'pay_to_win', 'Pay to win', 'say it is pay to win', 'bad', 'Does the reviewer say the game is pay to win, meaning that spending money gives an advantage or gates progress?', [
    ['says_not_pay_to_win', 'good', 'Not pay to win', 'Says the game is fair to players who pay nothing, or that purchases are cosmetic or optional'],
    ['says_pay_to_win', 'bad', 'Pay to win', 'Says spending money gives an advantage, or that progress is gated behind paying'],
  ], 'Does not discuss pay to win or in-game purchases'),

  topic('gameplay', 'difficulty', 'Difficulty', 'say the difficulty is well balanced', 'good', 'What does the reviewer say about the difficulty?', [
    ['well_balanced', 'good', 'Well balanced', 'Says the difficulty is about right or well tuned'],
    ['too_easy', 'bad', 'Too easy', 'Says it is too easy'],
    ['too_hard', 'bad', 'Too hard', 'Says it is too hard or punishing'],
  ], 'Does not discuss difficulty'),
  topic('gameplay', 'learning_curve', 'Learning curve', 'say it is easy to get into', 'good', 'What does the reviewer say about how easy the game is to learn and get into, such as the tutorial and the early hours?', [
    ['easy_to_learn', 'good', 'Easy to learn', 'Says the tutorial or early hours are approachable'],
    ['hard_to_learn', 'bad', 'Hard to get into', 'Says it is confusing, poorly explained or has a steep learning curve'],
  ], 'Does not discuss learning the game'),
  topic('gameplay', 'multiplayer', 'Multiplayer and matchmaking', 'are happy with matchmaking', 'good', 'What does the reviewer say about multiplayer matchmaking: queue times, finding games and match balance?', [
    ['good_matchmaking', 'good', 'Good', 'Says finding games is quick, or matches are fair and balanced'],
    ['bad_matchmaking', 'bad', 'Poor', 'Complains of long queues, empty lobbies, or unbalanced or unfair matches'],
  ], 'Does not discuss matchmaking or match balance'),
  topic('gameplay', 'friends', 'Fun with friends', 'say it is fun with friends', 'good', 'What does the reviewer say about playing the game with friends, such as co-op or party play?', [
    ['fun_with_friends', 'good', 'Fun with friends', 'Says it is fun, or best, played with friends'],
    ['not_fun_with_friends', 'bad', 'Not fun', 'Says playing with friends is not fun, is frustrating, or is badly supported'],
    ['only_with_friends', 'neutral', 'Only with friends', 'Says it is only fun with friends, and dull alone'],
  ], 'Does not discuss playing with friends'),
  topic('gameplay', 'ai_quality', 'AI quality', 'praise the AI', 'good', 'What does the reviewer say about the quality of the enemy or companion AI?', [
    ['good_ai', 'good', 'Good AI', 'Praises the AI as smart, or fun to play against or with'],
    ['bad_ai', 'bad', 'Bad AI', 'Criticizes the AI as dumb, broken or unfair'],
  ], 'Does not discuss the AI'),
  topic('gameplay', 'controls_ui', 'Controls and UI', 'say the controls and UI feel good', 'good', 'What does the reviewer say about the controls and the user interface?', [
    ['good_controls', 'good', 'Intuitive', 'Says controls and menus feel good or are easy to use'],
    ['bad_controls', 'bad', 'Clunky', 'Says controls or menus are clunky, confusing or badly designed'],
  ], 'Does not discuss controls or the interface'),

  topic('content', 'replayability', 'Lasting appeal', 'say it has plenty to do', 'good', 'What does the reviewer say about how much there is to do, and whether it stays fun over time?', [
    ['lots_to_do', 'good', 'Plenty to do', 'Says there is plenty of content, or that it stays fun to replay'],
    ['repetitive', 'bad', 'Repetitive or thin', 'Says it gets repetitive, runs out of content, or feels shallow'],
  ], 'Does not discuss content or replayability'),
  topic('content', 'story', 'Story and writing', 'praise the story or writing', 'good', 'What does the reviewer say about the story and writing?', [
    ['good_story', 'good', 'Good story', 'Praises the story, characters or writing'],
    ['weak_story', 'bad', 'Weak story', 'Criticizes the story, characters or writing'],
  ], 'Does not discuss the story or writing'),
  topic('content', 'monetization', 'DLC and season passes', 'complain about DLC or season passes', 'bad', 'What does the reviewer say about paid DLC and season passes, apart from microtransactions?', [
    ['fair_monetization', 'good', 'Fair', 'Says DLC or passes are fair, good value or generous'],
    ['greedy_monetization', 'bad', 'Greedy', 'Says they are overpriced, cut from the base game, or feel greedy'],
  ], 'Does not discuss DLC or season passes'),
  topic('content', 'microtransactions', 'Microtransactions', 'complain about microtransactions', 'bad', 'What does the reviewer say about microtransactions, meaning in-game purchases such as cosmetics, loot boxes and premium currency, apart from whether they give an advantage?', [
    ['fair_microtransactions', 'good', 'Fair', 'Says in-game purchases are optional, cosmetic or reasonably priced'],
    ['bad_microtransactions', 'bad', 'Bad', 'Complains of loot boxes, premium currency, or constant prompts to spend money'],
  ], 'Does not discuss in-game purchases'),
  topic('content', 'ai_slop', 'AI slop', 'complain of AI-generated content', 'bad', 'Does the reviewer say the game uses AI-generated content (art, voice acting, writing, music or code), and what do they think of it? This is about generative AI used to make the game, not the enemy or companion AI inside it.', [
    ['says_human_made', 'good', 'Human-made', 'Praises the game for having no AI-generated content, or for being made by people'],
    ['says_ai_slop', 'bad', 'AI slop', 'Complains of AI-generated art, voice, writing, music or code, or of low-effort AI content'],
    ['accepts_ai', 'neutral', 'AI, no complaint', 'Says the game uses AI-generated content without complaining about it'],
  ], 'Does not discuss AI-generated content'),
  topic('content', 'length', 'Length', 'say the length is about right', 'good', 'What does the reviewer say about how long the game is?', [
    ['just_right', 'good', 'About right', 'Says the length is about right'],
    ['too_short', 'bad', 'Too short', 'Says it is too short'],
    ['padded', 'bad', 'Padded', 'Says it is padded out or drags on'],
  ], 'Does not discuss the length'),

  topic('technical', 'performance', 'Runs badly', 'say it runs badly', 'bad', 'What does the reviewer say about how well the game runs on their computer (frame rate, stutter, lag, loading, optimization)?', [
    ['runs_well', 'good', 'Runs well', 'Says it runs smoothly or is well optimized'],
    ['runs_badly', 'bad', 'Runs badly', 'Complains of low frame rate, stutter, lag, long loading, or poor optimization'],
  ], 'Does not discuss how well it runs'),
  topic('technical', 'stability', 'Bugs and crashes', 'complain of bugs or crashes', 'bad', 'What does the reviewer say about bugs and crashes?', [
    ['stable', 'good', 'Stable', 'Says the game is stable, polished, or has few bugs'],
    ['buggy', 'bad', 'Buggy or crashes', 'Complains of bugs, crashes, glitches, or broken features'],
  ], 'Does not discuss bugs or stability'),
  topic('technical', 'save_issues', 'Lost progress', 'report lost or corrupted progress', 'bad', 'What does the reviewer say about saving and progression: lost, corrupted or reset progress?', [
    ['saves_fine', 'good', 'Saves fine', 'Says saving and progress work reliably'],
    ['lost_progress', 'bad', 'Lost progress', 'Reports lost, corrupted or reset saves or progress'],
  ], 'Does not discuss saves or progress'),
  topic('technical', 'netcode', 'Netcode and servers', 'are happy with online stability', 'good', 'What does the reviewer say about the quality of the online connection: lag, disconnects and servers?', [
    ['stable_online', 'good', 'Stable', 'Says online play is smooth and stable'],
    ['unstable_online', 'bad', 'Unstable', 'Complains of lag, desync, disconnects or server problems'],
  ], 'Does not discuss the online connection'),

  topic('community', 'dev_responsiveness', 'Developer responsiveness', 'praise the developers', 'good', 'What does the reviewer say about the developers: patches, communication and listening to feedback?', [
    ['responsive', 'good', 'Responsive', 'Praises patches, communication or listening to players'],
    ['unresponsive', 'bad', 'Unresponsive', 'Complains of neglect, no fixes, poor communication or ignoring feedback'],
  ], 'Does not discuss the developers'),
  topic('community', 'community', 'Community', 'find the community friendly', 'good', 'What does the reviewer say about the player community?', [
    ['friendly_community', 'good', 'Friendly', 'Says the community is friendly, welcoming or helpful'],
    ['toxic_community', 'bad', 'Toxic', 'Says the community is toxic or hostile'],
  ], 'Does not discuss the community'),
  topic('community', 'customer_support', 'Customer support', 'praise customer support', 'good', 'What does the reviewer say about customer support, such as refunds and ban appeals?', [
    ['good_support', 'good', 'Good', 'Says support was helpful or fair'],
    ['bad_support', 'bad', 'Bad', 'Says support was unhelpful, slow or unfair'],
  ], 'Does not discuss customer support'),

  topic('compared', 'comparison', 'Compared with others', 'say it beats its predecessor or similar games', 'good', 'How does the reviewer compare the game with its predecessor or similar games?', [
    ['better', 'good', 'Better', 'Says it is better than its predecessor or similar games'],
    ['worse', 'bad', 'Worse', 'Says it is worse than its predecessor or similar games'],
    ['similar', 'neutral', 'About the same', 'Says it is about as good as its predecessor or similar games'],
  ], 'Does not compare it with other games'),
];

/**
 * Where the reviewer plays. It is not a card of its own: it is crossed with the `performance` answer, to show how well
 * the game runs on each platform or kind of hardware that reviewers name (see `platforms` in a tally).
 */
export const STEAM_PLATFORM = {
  id: 'platform',
  question: 'Which platform or hardware does the reviewer say they play on?',
  options: [
    { key: 'steam_deck', label: 'Steam Deck', note: 'Plays on a Steam Deck' },
    { key: 'linux_desktop', label: 'Linux', note: 'Plays on a Linux desktop, or through Proton on Linux' },
    { key: 'macos', label: 'macOS', note: 'Plays on a Mac' },
    { key: 'windows_nvidia', label: 'Windows, Nvidia', note: 'Plays on Windows with an Nvidia graphics card (GeForce, RTX, GTX)' },
    { key: 'windows_amd', label: 'Windows, AMD', note: 'Plays on Windows with an AMD graphics card (Radeon, RX)' },
    { key: 'windows_intel', label: 'Windows, Intel', note: 'Plays on Windows with Intel or integrated graphics' },
    { key: 'windows_other', label: 'Windows, other', note: 'Plays on Windows without saying what graphics card' },
  ],
  absent: 'Does not say what they play on',
};

/** The questions Jev is asked about every review, in the request shape. Built from the topics, so the two cannot disagree. */
export function steamQuestions() {
  const questions = {};
  for (const t of STEAM_TOPICS) {
    questions[t.id] =
      t.type === 'noul'
        ? { type: 'noul', instructions: t.question, criteria: { true: t.options[0].note, false: t.options[1].note } }
        : { type: 'choice', instructions: t.question, criteria: { ...Object.fromEntries(t.options.map((o) => [o.key, o.note])), [NOT_MENTIONED]: t.absent } };
  }
  questions[STEAM_PLATFORM.id] = {
    type: 'choice',
    instructions: STEAM_PLATFORM.question,
    criteria: { ...Object.fromEntries(STEAM_PLATFORM.options.map((o) => [o.key, o.note])), [NOT_MENTIONED]: STEAM_PLATFORM.absent },
  };
  return questions;
}

/** Which questions count toward a composite score by default: only overall positivity (the rest are Choices to opt into). */
export function steamSpecs() {
  const specs = {};
  for (const t of STEAM_TOPICS) {
    specs[t.id] = t.type === 'noul' ? { enabled: true, weight: 100, invert: false, target: null } : { enabled: false, weight: 50, invert: false, target: t.options.find((o) => o.tone === 'good').key };
  }
  specs[STEAM_PLATFORM.id] = { enabled: false, weight: 50, invert: false, target: STEAM_PLATFORM.options[0].key };
  return specs;
}

const number = (n) => n.toLocaleString('en-US');
/** Hours as people say them: a decimal for a few, whole numbers once it is many. */
const hoursText = (h) => `${number(h < 100 ? Math.round(h * 10) / 10 : Math.round(h))} hour${h === 1 ? '' : 's'}`;

/**
 * What Jev reads for one review: a short, plain block rather than Steam's raw data. It says who is writing (how long they
 * have played, and whether they are still playing), anything that could colour the review (a free copy, a refund, Early
 * Access), and how many people found it helpful, then the review itself. A line with nothing to say is left out.
 *
 * `row` is the review's `text` and `meta` (what the server kept). With no `meta` it is just the text, under the game's name.
 *
 * Their thumbs up or down is left out unless `thumbs` is true. It is the answer key for the `positive` question, so
 * showing it makes that question, and the accuracy check on it, repeat the thumbs instead of reading the text.
 */
export function buildSteamState(gameName, row, { thumbs = false } = {}) {
  const m = row.meta ?? {};
  const facts = [];

  const played = [
    m.hoursTotal != null && `${hoursText(m.hoursTotal)} in total`,
    m.hoursAtReview != null && `${hoursText(m.hoursAtReview)} by the time they wrote the review`,
    m.hoursRecent != null && (m.hoursRecent > 0 ? `${hoursText(m.hoursRecent)} in the last two weeks` : 'none in the last two weeks'),
  ].filter(Boolean);
  if (played.length > 0) facts.push(`Playtime: ${played.join('; ')}.`);

  if (m.freeCopy) facts.push('Received the game for free.');
  if (m.refunded) facts.push('Refunded the game.');
  if (m.earlyAccess) facts.push('Wrote the review during Early Access.');
  if (m.steamDeck) facts.push('Plays mostly on a Steam Deck.');
  if (m.votesUp > 0) facts.push(`${number(m.votesUp)} ${m.votesUp === 1 ? 'person' : 'people'} found the review helpful.`);
  if (thumbs && m.votedUp != null) facts.push(`Their verdict on Steam: ${m.votedUp ? 'recommended' : 'not recommended'}.`);

  const name = gameName?.trim() || 'a game';
  const text = row.text.trim();
  return facts.length > 0 ? `Steam review of ${name}.\n\nAbout the reviewer:\n${facts.map((f) => `- ${f}`).join('\n')}\n\nReview:\n${text}` : `Steam review of ${name}:\n\n${text}`;
}

/**
 * Is this reply from the server one the page can carry on from? A server started before batches existed still returns
 * reviews, but with no cursor: it would give the same first reviews on every press and they would be counted twice. Returns
 * a message saying so, or null when the reply is fine.
 */
export function batchReplyProblem(reply) {
  if (typeof reply?.cursor === 'string' && typeof reply?.done === 'boolean') return null;
  return 'The running server is older than this page and cannot carry on from where a batch stopped, so it would read the same reviews again. Restart Jev Studio (stop it, then start it again) and try again.';
}

/** Steam's thumbs, as the expected answer for the `positive` question. */
export const expectedFor = (review) => ({ positive: review.votedUp ? 'yes' : 'no' });

/** How a share for the game reads: 'good' from two thirds up, 'bad' under two fifths, 'mixed' between, 'none' with no data. */
export function toneFor(goodShare) {
  if (goodShare == null) return 'none';
  if (goodShare >= 2 / 3) return 'good';
  if (goodShare >= 2 / 5) return 'mixed';
  return 'bad';
}

/* ---------- rolling the answers up ---------- */

/** The key a topic's answer counts under: yes or no for a Yes / No, else the option Jev chose (or null if it is not one we know). */
function answerKey(topic, answer) {
  if (topic.type === 'noul') return answer.noul >= 0.5 ? 'yes' : 'no';
  return topic.options.some((o) => o.key === answer.choice) || answer.choice === NOT_MENTIONED ? answer.choice : null;
}

const toneOf = (topic, key) => topic.options.find((o) => o.key === key)?.tone;

/**
 * Counts, not rows. A game can have hundreds of thousands of reviews, which is far more than a browser can keep, so a
 * finished batch is reduced to one of these and its rows are let go. They add up across batches (see mergeTallies).
 * For each topic: how many reviews answered it and how many chose each option. `platforms` counts, for each platform
 * that reviewers name, how many of them said the game runs well and how many said it runs badly.
 */
export const emptyTally = () => ({
  answered: 0,
  failed: 0,
  tokens: 0,
  topics: Object.fromEntries(
    STEAM_TOPICS.map((t) => [t.id, { answered: 0, options: Object.fromEntries([...t.options.map((o) => o.key), ...(t.absent ? [NOT_MENTIONED] : [])].map((key) => [key, 0])) }]),
  ),
  platforms: Object.fromEntries(STEAM_PLATFORM.options.map((o) => [o.key, { good: 0, bad: 0 }])),
});

/** What some rows amount to: how many were answered or failed, the tokens used, and how each topic's answers fell. */
export function tallyRows(rows) {
  const tally = emptyTally();
  const performance = STEAM_TOPICS.find((t) => t.id === 'performance');
  for (const row of rows) {
    if (row.status === 'error') tally.failed++;
    if (row.status !== 'ok') continue;
    tally.answered++;
    if (row.response?.usage) tally.tokens += row.response.usage.input_tokens + row.response.usage.output_tokens;
    const answers = row.response?.answers ?? {};

    for (const t of STEAM_TOPICS) {
      const a = answers[t.id];
      if (!a) continue;
      const counts = tally.topics[t.id];
      counts.answered++;
      const key = answerKey(t, a);
      if (key != null) counts.options[key]++;
    }

    // "Runs well or badly on this platform" needs both answers from the same review.
    const platform = answers[STEAM_PLATFORM.id]?.choice;
    const tone = answers.performance ? toneOf(performance, answers.performance.choice) : undefined;
    if (tally.platforms[platform] && (tone === 'good' || tone === 'bad')) tally.platforms[platform][tone]++;
  }
  return tally;
}

/** Two tallies added together. Neither is changed, and one with fields missing (an older or partial one) counts what it has. */
export function mergeTallies(a, b) {
  const merged = emptyTally();
  for (const t of [a, b]) {
    if (!t) continue;
    merged.answered += t.answered ?? 0;
    merged.failed += t.failed ?? 0;
    merged.tokens += t.tokens ?? 0;
    for (const [id, into] of Object.entries(merged.topics)) {
      const from = t.topics?.[id];
      into.answered += from?.answered ?? 0;
      for (const key of Object.keys(into.options)) into.options[key] += from?.options?.[key] ?? 0;
    }
    for (const [key, into] of Object.entries(merged.platforms)) {
      into.good += t.platforms?.[key]?.good ?? 0;
      into.bad += t.platforms?.[key]?.bad ?? 0;
    }
  }
  return merged;
}

/**
 * For each topic: how many answered reviews mention it and how the mentions fall between good, bad and neutral for the
 * game. A review that does not mention a topic says nothing about it, so it never counts for or against; that is why the
 * share is taken over the mentions rather than over every review. `tooFew` marks a topic with fewer than MIN_MENTIONS
 * mentions: too few to show a percentage, so the page leaves its card out.
 */
export function summarizeTally(tally) {
  const topics = STEAM_TOPICS.map((t) => {
    const counts = tally.topics[t.id];
    const options = t.options.map((o) => ({ ...o, n: counts.options[o.key] ?? 0 }));
    const total = (tone) => options.filter((o) => o.tone === tone).reduce((sum, o) => sum + o.n, 0);
    const good = total('good');
    const bad = total('bad');
    const neutral = total('neutral');
    const mentioned = good + bad + neutral;
    const goodShare = mentioned > 0 ? good / mentioned : null;
    const tooFew = mentioned < MIN_MENTIONS;
    return {
      ...t,
      options,
      answered: counts.answered,
      mentioned,
      good,
      bad,
      neutral,
      goodShare,
      // the big number: the share on the side the title names (null with nothing to divide)
      share: mentioned > 0 ? (t.headline === 'good' ? good : bad) / mentioned : null,
      mentionShare: counts.answered > 0 ? mentioned / counts.answered : null,
      tooFew,
      tone: tooFew ? 'none' : toneFor(goodShare),
    };
  });

  const platforms = STEAM_PLATFORM.options.map((o) => {
    const { good, bad } = tally.platforms[o.key];
    const mentioned = good + bad;
    const tooFew = mentioned < MIN_MENTIONS;
    return { key: o.key, label: o.label, good, bad, mentioned, tooFew, share: mentioned > 0 ? bad / mentioned : null, tone: tooFew ? 'none' : toneFor(good / mentioned) };
  });

  return { answered: tally.answered, failed: tally.failed, tokens: tally.tokens, topics, platforms };
}

/**
 * What the summary shows: the topics grouped under their headings, with every card that has too little data left out,
 * and any heading left with nothing under it left out too. `hidden` is how many topics were left out, so the page can
 * say why some are missing. Performance by platform sits in Technical, one row per platform with enough to go on.
 */
export function visibleGroups(summary) {
  const groups = STEAM_GROUPS.map((g) => ({
    ...g,
    topics: summary.topics.filter((t) => t.group === g.id && !t.tooFew),
    platforms: g.id === 'technical' ? summary.platforms.filter((p) => !p.tooFew) : [],
  })).filter((g) => g.topics.length > 0 || g.platforms.length > 0);
  return { groups, hidden: summary.topics.filter((t) => t.tooFew).length };
}

/** The summary for one run's rows: the same as a tally of them, plus how many rows there are. */
export const summarizeSteam = (run) => ({ total: run.rows.length, ...summarizeTally(tallyRows(run.rows)) });

/** How many of the fetched reviews are thumbs up, so it can be set beside Steam's overall figure. */
export function thumbsUpShare(reviews) {
  return reviews.length ? reviews.filter((r) => r.votedUp).length / reviews.length : null;
}

/* ---------- "Analyse more": how much, and what it costs ---------- */

/**
 * The slider that picks how much of the game to have analysed in total, as a percentage of its reviews. It runs from the
 * next step above what is already done up to 100%, so every position means at least one more review. The step is a tenth
 * of a percent for a game with thousands of reviews (a hundred is too coarse for 380,000), and a whole percent for a
 * small one. `done` is true when there is nothing left to choose.
 */
export function moreSlider(total, analysed) {
  const step = total >= 1000 ? 0.1 : 1;
  const current = total > 0 ? (analysed / total) * 100 : 0;
  const min = Math.round((Math.floor(current / step + 1e-9) + 1) * step * 100) / 100;
  return { step, min: Math.min(min, 100), max: 100, done: total <= 0 || analysed >= total || min > 100 };
}

/** How many reviews a percentage of the game is, never more than the game has. */
export const reviewsFor = (total, percent) => Math.max(0, Math.min(total, Math.round((total * percent) / 100)));

/** A token count as people say it, because ten digits are not readable: "1.2 billion", "48 million", "312,000". */
export function roughTokens(tokens) {
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(1)} billion`;
  if (tokens >= 1e7) return `${Math.round(tokens / 1e6)} million`;
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)} million`;
  return (Math.round(tokens / 1000) * 1000).toLocaleString('en-US');
}

/** A length of time as people say it. It is an estimate, so it is rounded and never more exact than that. */
export function roughDuration(seconds) {
  if (!(seconds > 0)) return 'no time';
  if (seconds < 90) return 'about a minute';
  const minutes = seconds / 60;
  if (minutes < 90) return `about ${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 36) return `about ${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours`;
  const days = hours / 24;
  return `about ${days < 10 ? days.toFixed(1) : Math.round(days)} days`;
}

/* ---------- filtering by an answer, and saving an analysis to carry on later ---------- */

/** Which option an answer counts under, for a topic: yes or no for a Yes / No, else the option Jev chose. */
export const topicAnswerKey = answerKey;

/** Did Jev's answer to this topic come out as this option, for this review? False for a review that has not been answered. */
export function rowHasAnswer(row, topicId, optionKey) {
  const topic = STEAM_TOPICS.find((t) => t.id === topicId);
  const answer = row.response?.answers?.[topicId];
  return row.status === 'ok' && Boolean(topic) && Boolean(answer) && answerKey(topic, answer) === optionKey;
}

/**
 * What to keep of the Steam page so the analysis can be looked at, or carried on, later: which game and how, where the
 * next batch starts, the counts for the batches before this one, and the batch on screen with its reviews, so a saved
 * page can show its table. The page is not changed. The batch is big (about 4 KB a review), so whoever saves this keeps
 * it apart from the small rest, in the browser's database; see savedTotal for reading the counts without it.
 */
export function snapshotOf(slice) {
  const run = slice.run ? structuredClone(slice.run) : null;
  if (run) for (const row of run.rows) if (row.status === 'running') row.status = 'pending'; // nothing is running in a saved copy
  return {
    url: slice.url,
    sort: slice.sort,
    count: slice.count,
    tellThumbs: slice.tellThumbs,
    game: slice.game,
    summary: slice.summary,
    key: slice.key,
    cursor: slice.cursor,
    exhausted: slice.exhausted,
    batches: slice.batches,
    tally: mergeTallies(emptyTally(), slice.tally), // the batches before the one on screen
    run,
  };
}

/** Counts for everything a saved analysis holds here: the earlier batches, plus the batch it holds inline, if it has one. */
export const savedTally = (saved) => mergeTallies(saved.tally, saved.run ? tallyRows(saved.run.rows) : null);

/**
 * The counts to show for a saved analysis, all batches included. A saved analysis keeps its batch in the browser's
 * database, away from its small record, so the record carries the total worked out at the time it was saved (`total`).
 * Older ones did not, and are worked out from what they hold.
 */
export const savedTotal = (saved) => (saved.total ? mergeTallies(emptyTally(), saved.total) : savedTally(saved));

/**
 * The parts of a saved analysis to put back on the Steam page to carry on. `run` is its batch, read from the database;
 * without it (the browser would not keep it, or it has been cleared) the batch's counts are folded into the totals, so
 * nothing already analysed is lost, but there is no table. Copies, so carrying on does not change the saved one.
 */
export function fieldsFromSaved(saved, run = null) {
  const kept = run ?? saved.run ?? null; // older saves kept an unfinished batch inline
  return {
    url: saved.url,
    sort: saved.sort,
    count: saved.count,
    tellThumbs: saved.tellThumbs === true,
    game: saved.game ?? null,
    summary: saved.summary ?? null,
    key: saved.key ?? null,
    cursor: typeof saved.cursor === 'string' ? saved.cursor : '*',
    exhausted: saved.exhausted === true,
    batches: Number.isInteger(saved.batches) ? saved.batches : 0,
    tally: kept ? mergeTallies(emptyTally(), saved.tally) : savedTotal(saved),
    run: kept ? structuredClone(kept) : null,
  };
}

/** The line under a review in the table: what Steam holds about it, whether or not Jev was shown it. */
export function describeSteamReview(meta) {
  if (!meta) return '';
  const hours = (h) => (h == null ? null : `${number(h)} h`);
  return [
    `${meta.votedUp ? 'Thumbs up' : 'Thumbs down'} on Steam`,
    meta.hoursTotal != null && `${hours(meta.hoursTotal)} played (${hours(meta.hoursAtReview) ?? '?'} at review, ${hours(meta.hoursRecent) ?? '?'} in the last two weeks)`,
    `${number(meta.votesUp ?? 0)} found it helpful`,
    meta.freeCopy && 'free copy',
    meta.refunded && 'refunded',
    meta.earlyAccess && 'written in Early Access',
    meta.steamDeck && 'plays on Steam Deck',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The filter for a click on a count on a card: the reviews that gave that answer. The table holds one batch, so when the
 * count covers more than one the bar says the table has only the batch it has (`where` names it).
 */
export function steamFilter(topic, option, { batches = 1, where = 'this one' } = {}) {
  return {
    key: `${topic.id}:${option.key}`, // which answer this is, so a menu can show it as selected however the filter was set
    label: pickLabel(topic, option),
    test: (row) => rowHasAnswer(row, topic.id, option.key),
    note: batches > 1 ? `The count covers every batch; the table holds only ${where}.` : '',
  };
}

/** What the filter bar calls a clicked count: the option alone when it already names the topic, else "Topic: Option". */
export function pickLabel(topic, option) {
  const a = topic.label.toLowerCase();
  const b = option.label.toLowerCase();
  return a.includes(b) || b.includes(a) ? option.label : `${topic.label}: ${option.label}`;
}

/**
 * Every answer a review can have, as choices for a filter menu: for each topic, one choice per option ("Friendly",
 * "Toxic", "Unresponsive"...), each with the filter that shows the reviews that gave it. The menu itself decides which
 * to list (it counts the reviews in the batch on screen and leaves out the ones nobody gave).
 */
export function steamFilterChoices({ batches = 1, where = 'this one' } = {}) {
  return STEAM_TOPICS.map((topic) => ({
    group: topic.label,
    items: topic.options.map((option) => ({ label: option.label, filter: steamFilter(topic, option, { batches, where }) })),
  }));
}
