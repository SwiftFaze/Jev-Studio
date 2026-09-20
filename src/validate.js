export const DEFAULT_MODEL = 'jev-latest';
export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasContent = (v) =>
  typeof v === 'string' ? v.trim().length > 0 : v !== null && typeof v === 'object' && Object.keys(v).length > 0;

function normalizeState(state) {
  if (state === undefined || state === null) return { ok: true, value: null };
  if (typeof state === 'string') return { ok: true, value: state.trim() === '' ? null : state };
  if (typeof state === 'object') return { ok: true, value: state }; // object or array
  return { ok: false };
}

function validateQuestion(id, q) {
  const at = `Question "${id}"`;
  if (!id.trim()) return ['Every question needs an id.'];
  if (!isPlainObject(q)) return [`${at} must be an object.`];
  if (!QUESTION_TYPES.has(q.type)) return [`${at}: type must be one of noul, choice, score.`];

  const errors = [];
  if (!hasContent(q.instructions)) errors.push(`${at}: the question text is required.`);
  const criteria = q.criteria;

  if (q.type === 'choice') {
    const keys = isPlainObject(criteria) ? Object.keys(criteria) : [];
    if (keys.length < 2) errors.push(`${at}: a choice needs at least 2 options.`);
    else if (keys.length > MAX_CHOICE_OPTIONS) errors.push(`${at}: a choice allows at most ${MAX_CHOICE_OPTIONS} options.`);
    else {
      if (keys.some((k) => !k.trim())) errors.push(`${at}: every option needs a key.`);
      for (const [key, desc] of Object.entries(criteria)) {
        if (desc !== null && typeof desc !== 'string') errors.push(`${at}: option "${key}" description must be text or null.`);
      }
    }
  } else if (q.type === 'score') {
    if (!Array.isArray(criteria) || criteria.length < MIN_SCORE_LEVELS || criteria.length > MAX_SCORE_LEVELS) {
      errors.push(`${at}: a score needs ${MIN_SCORE_LEVELS}-${MAX_SCORE_LEVELS} levels.`);
    } else if (criteria.some((level) => typeof level !== 'string' || !level.trim())) {
      errors.push(`${at}: every score level needs a description.`);
    }
  } else if (criteria !== undefined) {
    const valid =
      isPlainObject(criteria) &&
      Object.entries(criteria).every(([k, v]) => (k === 'true' || k === 'false') && typeof v === 'string');
    if (!valid) errors.push(`${at}: yes/no criteria may only contain "true" and "false" descriptions.`);
  }
  return errors;
}

/** Validate a /api/run body before it is forwarded upstream. */
export function validateRequest(body) {
  if (!isPlainObject(body)) return { ok: false, errors: ['Request body must be a JSON object.'] };

  const errors = [];
  // The input is optional. The API's `state` key is always sent, but its value may be null, which is what
  // "no input" means: blank text, or nothing at all, becomes null.
  const state = normalizeState(body.state);
  if (!state.ok) errors.push('The input (state) must be text, an object, an array, or empty.');

  const model = body.model ?? DEFAULT_MODEL;
  if (typeof model !== 'string' || !model.trim()) errors.push('`model` must be a non-empty string.');

  if (!isPlainObject(body.questions) || Object.keys(body.questions).length === 0) {
    errors.push('Add at least one question.');
  } else {
    for (const [id, q] of Object.entries(body.questions)) errors.push(...validateQuestion(id, q));
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { state: state.value, model, questions: body.questions } };
}
