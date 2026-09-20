import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sea from 'node:sea';

/** True when running as the packaged single-file executable (the UI files are inside it, not on disk). */
export const isPackaged = () => sea.isSea();

/** Read UI files from a folder on disk. Resolves to a Buffer, or null when there is no such file. */
export function diskAssets(publicDir) {
  const root = path.resolve(publicDir);
  return async (rel) => {
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) return null; // path traversal
    try {
      return await readFile(file);
    } catch {
      return null;
    }
  };
}

/** Read UI files embedded in the executable (see scripts/build.mjs, which stores each as `public/<path>`). */
export function packagedAssets() {
  return async (rel) => {
    if (rel.split('/').includes('..')) return null;
    try {
      return Buffer.from(sea.getAsset(`public/${rel}`));
    } catch {
      return null; // getAsset throws for a key that was not embedded
    }
  };
}
