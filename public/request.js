// Pure logic (no DOM): converts between the editor's draft model and the System One request shape.

export const DEFAULT_MODEL = 'jev-latest';

let counter = 0;
const uid = () => `q${Date.now().toString(36)}${(counter++).toString(36)}`;

export function newQuestion(overrides = {}) {
  return {
    uid: uid(),
    id: '',
    type: 'choice',
    instructions: '',
    options: [
      { key: '', desc: '' },
      { key: '', desc: '' },
    ],
    noul: { yes: '', no: '' },
    levels: ['', ''],
    ...overrides,
  };
}

export const blankDraft = (type = 'choice') => ({
  stateText: '',
  questions: [newQuestion({ id: 'question_1', type })],
});

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/**
 * Structured state -> readable plain text: "key: value" lines, nested keys joined with dots.
 * Used for older drafts and history entries that were saved in the removed JSON input mode.
 */
export function stateToText(state) {
  if (state == null) return '';
  if (typeof state === 'string') return state;
  if (state !== null && typeof state === 'object' && !Array.isArray(state)) {
    const keys = Object.keys(state);
    // The old Text -> JSON toggle wrapped free text as { "text": "..." }; unwrap it.
    if (keys.length === 1 && keys[0] === 'text' && typeof state.text === 'string') return state.text;
  }
  const lines = [];
  const walk = (value, path) => {
    if (value !== null && typeof value === 'object') {
      const entries = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v]) : Object.entries(value);
      for (const [key, inner] of entries) walk(inner, path ? `${path}.${key}` : key);
    } else {
      lines.push(path ? `${path}: ${value}` : String(value));
    }
  };
  walk(state, '');
  return lines.join('\n');
}

function questionFromApi(id, q) {
  const base = { id, type: q.type, instructions: asText(q.instructions) };
  if (q.type === 'choice') {
    base.options = Object.entries(q.criteria ?? {}).map(([key, desc]) => ({ key, desc: desc ?? '' }));
  } else if (q.type === 'score') {
    base.levels = [...(q.criteria ?? [])];
  } else {
    base.noul = { yes: q.criteria?.true ?? '', no: q.criteria?.false ?? '' };
  }
  return newQuestion(base);
}

/** API-shaped questions map -> editor question list. */
export const questionsFromApi = (questions) => Object.entries(questions).map(([id, q]) => questionFromApi(id, q));

/** API-shaped request -> editable draft (used for templates and history restore). */
export function draftFromRequest(request) {
  return {
    stateText: stateToText(request.state),
    questions: questionsFromApi(request.questions),
  };
}

/** Drafts saved while the JSON input mode existed: drop the mode and turn JSON input into plain text. */
export function migrateDraft(draft) {
  const { stateMode, ...rest } = draft;
  if (stateMode === 'json') {
    try {
      rest.stateText = stateToText(JSON.parse(draft.stateText));
    } catch {
      /* not valid JSON: leave the text as typed */
    }
  }
  return rest;
}

/** Copy of a question with a fresh uid and an unused id ("billing" -> "billing_copy", "billing_copy2", ...). */
export function duplicateQuestion(q, takenIds = []) {
  const taken = new Set(takenIds);
  const base = `${q.id.trim() || 'question'}_copy`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
  const { uid: _dropped, ...rest } = structuredClone(q);
  return newQuestion({ ...rest, id });
}

function buildQuestion(q) {
  const out = { type: q.type, instructions: q.instructions.trim() };

  if (q.type === 'choice') {
    const keys = q.options.map((o) => o.key.trim()).filter(Boolean);
    if (new Set(keys).size !== keys.length) throw new Error('option keys must be unique.');
    out.criteria = Object.fromEntries(
      q.options.filter((o) => o.key.trim()).map((o) => [o.key.trim(), o.desc.trim() || null]),
    );
  } else if (q.type === 'score') {
    out.criteria = q.levels.map((l) => l.trim()).filter(Boolean);
  } else {
    const yes = q.noul.yes.trim();
    const no = q.noul.no.trim();
    if (yes || no) {
      if (!(yes && no)) throw new Error('fill in both "Yes means" and "No means", or leave both empty.');
      out.criteria = { true: yes, false: no };
    }
  }
  return out;
}

/** Editor question list -> API questions map. Throws an Error with a user-facing message. */
export function buildQuestions(list) {
  const questions = {};
  for (const q of list) {
    const id = q.id.trim();
    if (!id) throw new Error('Every question needs an id.');
    if (id in questions) throw new Error(`Two questions share the id "${id}".`);
    try {
      questions[id] = buildQuestion(q);
    } catch (err) {
      throw new Error(`Question "${id}": ${err.message}`);
    }
  }
  return questions;
}

/**
 * Draft -> System One request body. Throws an Error with a user-facing message.
 * The input is optional: an empty box sends `state: null`, which the API accepts for self-contained questions.
 */
export function buildRequest(draft) {
  const state = draft.stateText.trim() === '' ? null : draft.stateText;
  return { state, model: DEFAULT_MODEL, questions: buildQuestions(draft.questions) };
}
