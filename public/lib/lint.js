// Advice on how a question is written, based on TypeSafe's guidance: one narrow judgment per question,
// options that cover the cases, and concrete descriptions. Notes are suggestions only and never block a run.

const CATCH_ALL = /^(other|others|none|none_of_the_above|neither|unknown|unclear|n_a|na|not_applicable|no_match|misc|miscellaneous)$/i;
const WH_START = /^(what|which|who|whom|whose|where|when|why|how)\b/i;
const YES_NO_START = /^(is|are|was|were|does|do|did|can|could|should|has|have|will|would)\b/i;
const YES_NO_KEYS = new Set(['yes', 'no', 'true', 'false']);

const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** @returns {{ level: 'warn' | 'info', message: string }[]} */
export function lintQuestion(q) {
  const notes = [];
  const add = (level, message) => notes.push({ level, message });
  const text = (q.instructions ?? '').trim();

  if (text) {
    if (text.length < 12) {
      add('warn', 'Very short. Jev only sees this text and the input, so say what to judge and about what.');
    }
    if ((text.match(/\?/g) ?? []).length > 1) {
      add('warn', 'More than one question mark. Ask one narrow judgment per question and split the rest out.');
    }
    if (q.type !== 'choice' && /\band\b/i.test(text)) {
      add('warn', 'The wording joins two things with "and". If they can differ, split them into separate questions.');
    }
    if (q.type === 'noul' && WH_START.test(text)) {
      add('warn', 'A Yes / No question should be answerable with yes or no. "What / which / how" fits Choice or Score better.');
    }
    if (q.type === 'score' && YES_NO_START.test(text)) {
      add('info', 'A Score asks "how much". If this is really a yes-or-no matter, the Yes / No type is simpler.');
    }
  }

  if (q.type === 'choice') {
    const options = q.options.filter((o) => o.key.trim());
    if (options.length >= 2) {
      const keys = options.map((o) => o.key.trim());
      if (keys.length === 2 && keys.every((k) => YES_NO_KEYS.has(k.toLowerCase()))) {
        add('info', 'Two yes/no options: the Yes / No type gives one probability and is simpler to read.');
      } else if (!keys.some((k) => CATCH_ALL.test(k))) {
        add('info', 'If nothing might fit, add an "other" option so Jev is not forced to pick a wrong one.');
      }
      const undescribed = options.filter((o) => !o.desc.trim()).length;
      if (undescribed > 0) {
        add('info', `${plural(undescribed, 'option')} without a description. Short descriptions help Jev tell options apart.`);
      }
    }
  } else if (q.type === 'score') {
    const filled = q.levels.map((level, i) => ({ text: level.trim(), i })).filter((l) => l.text);
    const vague = filled.filter((l) => wordCount(l.text) < 3).map((l) => l.i);
    if (vague.length > 0) {
      add('warn', `Level${vague.length === 1 ? '' : 's'} ${vague.join(', ')} ${vague.length === 1 ? 'is' : 'are'} vague. Describe a concrete situation for each level.`);
    }
    const lowered = filled.map((l) => l.text.toLowerCase());
    if (new Set(lowered).size !== lowered.length) add('warn', 'Two levels have the same description, so Jev cannot tell them apart.');
    if (filled.length === 2) add('info', 'Only 2 levels: a Yes / No question would be simpler.');
    if (filled.length > 7) add('info', 'Many levels are hard to tell apart. 3 to 5 is usually easier to describe well.');
  } else if (!q.noul.yes.trim() && !q.noul.no.trim()) {
    add('info', 'Adding what "yes" and "no" mean makes the answer sharper.');
  }

  return notes;
}
