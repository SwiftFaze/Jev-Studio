import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Load a .env file into `env`, letting the file win over variables already set in the environment.
 * (Node's own --env-file does the opposite, which would silently keep a stale system-wide key.)
 * Returns the names it set; a missing file is not an error.
 */
export function loadDotEnv(file, env = process.env) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const parsed = parseEnv(text);
  Object.assign(env, parsed);
  return Object.keys(parsed);
}
