import { articleUrl } from './wikipedia.js';

// A finished run as a Markdown report: the answer, where it came from, what it cost, and the paths taken, which is every step Jev
// took with what it picked, how sure it was, and what else it weighed. It reads the same trail the page draws, whether from a run
// that has just finished or from a saved answer, so a report can be made from either.

const NAMES = { term: 'Search term', article: 'Article', part: 'Part', answer: 'Answer', check: 'Check', refine: 'Refine' };
const NUMBERS = { term: 1, article: 2, part: 3, answer: 4, check: 5, refine: 6 };
const QUOTED = new Set(['term', 'answer', 'refine']); // a step whose pick is text taken from somewhere
const pct = (p) => `${Math.round(p * 100)}%`;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Filename-safe words from a question: "How big is Paris?" is "how-big-is-paris". */
export const slugOf = (text) => oneLine(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'answer';

/** What else was weighed at a step, best first: up to five, and how many more there were. */
function otherOptions(step) {
  const options = (step.options ?? []).filter((o) => o.key !== step.chosen).sort((a, b) => b.p - a.p);
  if (options.length === 0) return '';
  const shown = options.slice(0, 5).map((o) => `${clip(oneLine(o.label), 120)} ${pct(o.p)}`);
  return `Other options: ${shown.join('; ')}${options.length > 5 ? `; and ${options.length - 5} more` : ''}`;
}

function stepLines(step) {
  const name = NAMES[step.id];
  const label = QUOTED.has(step.id) ? `“${oneLine(step.label)}”` : oneLine(step.label);
  const number = NUMBERS[step.id];
  if (step.skipped) return [`${number}. **${name}** ${label} — skipped: ${step.skipped}`];
  // A step with no request of its own (the next best part, the next best answer) is a branch of the one above it.
  if (step.reused && step.instructions == null) return [`   - Then tried **${name.toLowerCase()}** ${label} — ${pct(step.p)}${step.note ? ` (${step.note})` : ''}`];
  const lines = [`${number}. **${name}** ${label} — ${pct(step.p)}${step.note ? ` (${step.note})` : ''}`];
  if (step.meaning?.label) lines.push(`   - The question asks for: ${step.meaning.label} ${pct(step.meaning.p)}${(step.meaning.options ?? []).filter((o) => o.key !== step.meaning.chosen && o.p >= 0.005).map((o) => `, ${o.key} ${pct(o.p)}`).join('')}`);
  const others = otherOptions(step);
  if (others) lines.push(`   - ${others}`);
  return lines;
}

/**
 * The paths taken, as numbered steps in groups: a new path begins with each search term. \`trail\` is the list of steps of a run.
 */
export function pathsSection(trail) {
  if (trail.length === 0) return ['No steps were taken.'];
  const lines = [];
  let path = 0;
  trail.forEach((step, i) => {
    if (step.id === 'term' || i === 0) {
      path += 1;
      if (lines.length) lines.push('');
      lines.push(`### Path ${path}: search term “${oneLine(step.id === 'term' ? step.label : '')}”`, step.note ? `_${step.note}_` : '', '');
    }
    lines.push(...stepLines(step));
  });
  return lines.filter((line, i, all) => !(line === '' && all[i - 1] === ''));
}

/**
 * The whole report. \`status\` is 'found', 'not-found' or 'stopped'; \`answer\` (or, when nothing passed, \`best\`) is
 * \`{ text, refined, title, part, url, checked }\`; \`stats\` is \`{ requests, tokens, ms, articles, terms }\`; \`read\` is the titles of the
 * articles opened, when known. \`requestLimit\` is the limit the run had (null for none).
 */
export function answerReport({ question, status = 'found', reason = '', answer = null, best = null, trail = [], stats = null, read = [], requestLimit = null, when = null }) {
  const lines = [`# ${oneLine(question)}`, ''];
  if (when) lines.push(`_${when}_`, '');

  if (status === 'found' && answer) {
    lines.push('## Answer', '', `> ${oneLine(answer.refined || answer.text)}`, '');
    if (answer.refined) lines.push(`From the row: ${oneLine(answer.text)}`, '');
    lines.push(...sourceLines(answer));
  } else {
    lines.push('## Result', '', status === 'stopped' ? 'Stopped before an answer was found.' : `Not found. ${reason}`.trim(), '');
    if (best) lines.push('The closest text Jev saw:', '', `> ${oneLine(best.text)}`, '', ...sourceLines(best));
  }

  if (stats) {
    lines.push('## What it cost', '');
    lines.push(`- Requests to Jev: ${stats.requests}${requestLimit != null && Number.isFinite(requestLimit) ? ` of ${requestLimit}` : ''}`);
    lines.push(`- Tokens: ${stats.tokens.toLocaleString('en-US')}`);
    lines.push(`- Time: ${(stats.ms / 1000).toFixed(1)} s`);
    if (stats.terms?.length) lines.push(`- ${stats.terms.length === 1 ? 'Search term' : 'Search terms'} tried: ${stats.terms.map((t) => `“${t}”`).join(', ')}`);
    const titles = read.length ? read : [];
    lines.push(`- ${plural(stats.articles, 'article')} read${titles.length ? `: ${titles.join(', ')}` : ''}`);
    lines.push('');
  }

  lines.push('## Paths taken', '', ...pathsSection(trail), '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** The Wikipedia page and part an answer is from, and how sure the final check was. */
function sourceLines(answer) {
  const page = articleUrl(answer.title);
  const lines = [`- Wikipedia page: [${answer.title}](${page})`];
  const hasHeading = answer.url?.includes('#');
  lines.push(hasHeading ? `- Part: [${answer.part}](${answer.url})` : `- Part: ${answer.part || 'Lead'}`);
  if (Number.isFinite(answer.checked)) lines.push(`- Final check: ${pct(answer.checked)}`);
  lines.push('');
  return lines;
}
