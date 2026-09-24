// Saved question sets: named lists of questions, kept in the browser and shareable as a small JSON file.

export const SET_FORMAT = 'jev-studio-question-set';
export const MAX_SET_QUESTIONS = 100;

const TYPES = new Set(['choice', 'noul', 'score']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const MAX_DESCRIPTION = 500;

/** `description` says what to paste into the context box on the set's page; it is left out of the file when empty. */
export const exportSet = (name, questions, description = '') => ({
  format: SET_FORMAT,
  version: 1,
  name,
  ...(description.trim() ? { description: description.trim() } : {}),
  questions,
});

function checkQuestion(id, q) {
  const at = `Question "${id}"`;
  if (!id.trim() || id.length > 100) return 'Every question needs an id of 1 to 100 characters.';
  if (!isObject(q) || !TYPES.has(q.type)) return `${at} has an unknown type.`;
  if (typeof q.instructions !== 'string' || !q.instructions.trim()) return `${at} has no question text.`;

  if (q.type === 'choice') {
    if (!isObject(q.criteria) || Object.keys(q.criteria).length === 0) return `${at} has no options.`;
    if (Object.values(q.criteria).some((d) => d !== null && typeof d !== 'string')) return `${at} has an invalid option description.`;
  } else if (q.type === 'score') {
    if (!Array.isArray(q.criteria) || q.criteria.length === 0 || q.criteria.some((l) => typeof l !== 'string')) {
      return `${at} has invalid score levels.`;
    }
  } else if (q.criteria !== undefined) {
    const ok = isObject(q.criteria) && Object.entries(q.criteria).every(([k, v]) => (k === 'true' || k === 'false') && typeof v === 'string');
    if (!ok) return `${at} has invalid yes/no criteria.`;
  }
  return null;
}

/**
 * Problems that would make a set fail the moment it is run, using the API's limits (a choice needs 2 or more
 * options, a score 2 to 10 levels). Used before saving, so a broken set never reaches the menu. Empty list means fine.
 */
export function saveProblems(questions) {
  const problems = [];
  const entries = Object.entries(questions);
  if (entries.length === 0) return ['Add at least one question first.'];
  for (const [id, q] of entries) {
    const basic = checkQuestion(id, q);
    if (basic) problems.push(basic);
    else if (q.type === 'choice' && Object.keys(q.criteria).length < 2) problems.push(`Question "${id}" needs at least 2 options.`);
    else if (q.type === 'score' && (q.criteria.length < 2 || q.criteria.length > 10)) problems.push(`Question "${id}" needs 2 to 10 score levels.`);
  }
  return problems;
}

/** Parse and check an imported file. Throws an Error with a user-facing message. */
export function parseSetFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!isObject(data) || data.format !== SET_FORMAT) throw new Error('That does not look like a Jev Studio question set file.');
  if (data.version !== 1) throw new Error(`Unsupported question set version (${data.version}).`);
  if (!isObject(data.questions) || Object.keys(data.questions).length === 0) throw new Error('That question set has no questions.');
  if (Object.keys(data.questions).length > MAX_SET_QUESTIONS) throw new Error(`Question sets are limited to ${MAX_SET_QUESTIONS} questions.`);

  for (const [id, q] of Object.entries(data.questions)) {
    const problem = checkQuestion(id, q);
    if (problem) throw new Error(problem);
  }
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 80) : 'Imported set';
  const description = typeof data.description === 'string' ? data.description.trim().slice(0, MAX_DESCRIPTION) : '';
  return { name, description, questions: data.questions };
}

/**
 * Which page a set is edited on. Sets saved from Batch go back to Batch, which has its own questions; every other set
 * (saved elsewhere, or imported from a file) is edited on Single, which takes any question type.
 */
export const editPageOf = (set) => (set?.origin === 'batch' ? 'batch' : 'custom');
export const EDIT_PAGE_LABEL = { custom: 'Single', batch: 'Batch' };

/**
 * Whether opening a set just shows it, rather than giving it a page that runs it. A set saved from Batch runs each
 * pasted line as its own item against its questions, which only the Batch page does, so its own page has nothing to
 * run: it shows what is in the set, and Batch is one button away. Every other set opens on a page that does run it.
 */
export const isViewOnly = (set) => editPageOf(set) === 'batch';

export const QUESTION_TYPE_LABEL = { choice: 'Choice', noul: 'Yes / No', score: 'Score' };

/**
 * A set's questions in the shape a read-only view draws: the id, the type and its label, the question itself, and
 * whatever that type carries — a choice's options (key and description), a score's levels in order, or a yes / no's
 * true / false descriptions when it was given them. Order is the set's own. Anything malformed is described as far as
 * it goes rather than dropped: this only ever shows a set, so it must never be the thing that fails.
 */
export function describeQuestions(questions) {
  return Object.entries(isObject(questions) ? questions : {}).map(([id, q]) => {
    const type = TYPES.has(q?.type) ? q.type : null;
    const out = {
      id,
      type,
      label: type ? QUESTION_TYPE_LABEL[type] : 'Unknown type',
      instructions: typeof q?.instructions === 'string' ? q.instructions : '',
      options: [],
      levels: [],
    };
    const criteria = q?.criteria;
    if (type === 'choice' && isObject(criteria)) {
      out.options = Object.entries(criteria).map(([key, desc]) => ({ key, desc: typeof desc === 'string' ? desc : '' }));
    } else if (type === 'score' && Array.isArray(criteria)) {
      out.levels = criteria.filter((level) => typeof level === 'string');
    } else if (type === 'noul' && isObject(criteria)) {
      // Only the two the API allows, and only when they are really there: a yes / no usually has no criteria at all.
      out.options = ['true', 'false'].filter((key) => typeof criteria[key] === 'string').map((key) => ({ key, desc: criteria[key] }));
    }
    return out;
  });
}

/** Add a set, replacing one with the same name (case-insensitive). Newest first. `origin: 'batch'` marks a set saved from Batch. */
export function upsertSet(sets, name, questions, { description = '', origin = null, now = Date.now() } = {}) {
  const clean = name.trim();
  if (!clean) throw new Error('Give the set a name.');
  const existing = sets.find((s) => s.name.toLowerCase() === clean.toLowerCase());
  const entry = { id: existing?.id ?? `s${now.toString(36)}`, name: clean.slice(0, 80), description: description.trim().slice(0, MAX_DESCRIPTION), savedAt: now, questions };
  if (origin === 'batch') entry.origin = origin;
  return [entry, ...sets.filter((s) => s !== existing)];
}

export const removeSet = (sets, id) => sets.filter((s) => s.id !== id);
