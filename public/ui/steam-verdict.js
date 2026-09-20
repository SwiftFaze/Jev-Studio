import { h } from '../dom.js';
import { bar, pct } from '../results.js';
import { MIN_MENTIONS, summarizeTally, visibleGroups } from '../lib/steam.js';

const number = (n) => n.toLocaleString('en-US');
const plural = (n, word) => `${number(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * Every option's count, the side the title names first, so "Pay to win: 0" sits beside a 0%. Where there is a table to
 * filter (`onPick` is given), a count above zero is a button that shows the reviews behind it; a zero has nothing to show.
 */
function counts(t, onPick) {
  const first = t.options.filter((o) => o.tone === t.headline);
  const rest = t.options.filter((o) => o.tone !== t.headline);
  const parts = [...first, ...rest].map((o) => {
    const text = `${o.label}: ${number(o.n)}`;
    if (!onPick || o.n === 0) return text;
    return h('button', { type: 'button', class: 'steam-pick', title: `Show the reviews that say this: ${o.note}`, onclick: () => onPick(t, o) }, text);
  });
  return h('p', { class: 'small' }, parts.flatMap((part, i) => (i ? [' · ', part] : [part])));
}

function topicCard(t, onPick) {
  const everyone = t.type === 'noul'; // "Positive" is asked of every review; the others only count the reviews that bring the topic up
  return h(
    'article',
    { class: `ov-card tone-${t.tone}`, 'data-topic': t.id },
    h('header', { class: 'a-head' }, h('h3', {}, t.label), h('span', { class: 'tag' }, everyone ? 'every review' : `${number(t.mentioned)} of ${number(t.answered)} mention it`)),
    h('div', { class: 'steam-share' }, h('strong', { class: 'steam-share-value' }, pct(t.share)), h('span', { class: 'muted' }, t.says)),
    bar(t.share),
    counts(t, onPick),
  );
}

/** How well it runs on each platform or kind of hardware that reviewers name: one row each, with the share who say it runs badly. */
function platformCard(rows) {
  return h(
    'article',
    { class: 'ov-card', 'data-topic': 'platform' },
    h('header', { class: 'a-head' }, h('h3', {}, 'Performance by platform'), h('span', { class: 'tag' }, 'reviews that say what they play on')),
    rows.map((p) =>
      h(
        'div',
        { class: `steam-platform tone-${p.tone}` },
        h('span', { class: 'steam-platform-name' }, p.label),
        bar(p.share),
        h('span', { class: 'steam-platform-value small' }, `${pct(p.share)} run badly · ${number(p.mentioned)}`),
      ),
    ),
  );
}

/**
 * "What reviewers say": the topics under their headings, one card each, with the share for the topic among the reviews
 * that bring it up. Green when that is good for the game, amber when mixed, red when bad. A topic that too few reviews
 * mention has no card at all, and a heading with no cards is left out; a line says how many are still missing.
 * `tally` is the counts for every review read so far, across every batch (see mergeTallies); it is rebuilt each time,
 * so the cards appear and fill in as a run goes. `steamTotal` is how many reviews the game has, to say how much of it
 * this covers. `onPick(topic, option)` makes each count clickable, to show the reviews behind it.
 */
export function renderSteamVerdict(root, tally, { steamTotal = 0, onPick = null } = {}) {
  const sum = tally ? summarizeTally(tally) : null;
  if (!sum || sum.answered === 0) return root.replaceChildren(h('p', { class: 'muted' }, 'This fills in as Jev reads the reviews: for each topic, how many reviews mention it and what they say.'));

  const { groups, hidden } = visibleGroups(sum);
  const of = steamTotal > 0 ? `, ${pct(Math.min(1, sum.answered / steamTotal))} of the ${number(steamTotal)} on Steam` : '';
  const intro = `From the ${plural(sum.answered, 'review')} Jev has read so far${of}. A review that does not mention a topic is left out of that topic's percentage.${onPick ? ' Click a count to see those reviews.' : ''}`;
  const note = hidden > 0 ? `${plural(hidden, 'topic')} ${hidden === 1 ? 'is' : 'are'} not shown yet: fewer than ${MIN_MENTIONS} reviews mention ${hidden === 1 ? 'it' : 'them'}.` : '';

  root.replaceChildren(
    h('p', { class: 'muted small' }, intro, note && ` ${note}`),
    ...(groups.length === 0 ? [h('p', { class: 'muted' }, `No topic has ${MIN_MENTIONS} reviews mentioning it yet. Cards appear as they do.`)] : []),
    ...groups.map((g) => h('section', { class: 'steam-group', 'aria-label': g.label }, h('h3', { class: 'steam-group-title' }, g.label), h('div', { class: 'ov-cards' }, [...g.topics.map((t) => topicCard(t, onPick)), g.platforms.length > 0 ? platformCard(g.platforms) : null]))),
  );
}
