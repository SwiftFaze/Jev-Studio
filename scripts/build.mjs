// Builds the standalone executable for the OS this runs on: dist/jev-studio-<os>-<arch>[.exe].
//
// It bundles src/ into one CommonJS file (esbuild), embeds that plus every file under public/ into a Node
// single-executable-application blob, and injects the blob into a copy of the running `node` binary (postject).
// Run it once per target OS: the release workflow does that on a runner for each.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postject from 'postject';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
process.chdir(root);

const OS_NAMES = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const osName = OS_NAMES[process.platform];
if (!osName) throw new Error(`Unsupported platform: ${process.platform}`);
const exe = path.join(dist, `jev-studio-${osName}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);

/** Every file under a folder, as forward-slash paths relative to it. */
function listFiles(dir, prefix = '') {
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(path.join(dir, name)).isDirectory() ? listFiles(path.join(dir, name), rel) : [rel];
  });
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

console.log('1/4 bundling src/ ...');
await build({
  entryPoints: ['src/cli.js'],
  outfile: 'dist/jev-studio.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  // import.meta does not exist in CommonJS. The only uses are for finding files on disk, which the packaged app never does.
  define: { 'import.meta.url': JSON.stringify('file:///not-used-when-packaged') },
  logLevel: 'warning',
});

console.log('2/4 embedding the UI and creating the SEA blob ...');
const assets = Object.fromEntries(listFiles('public').map((rel) => [`public/${rel}`, `public/${rel}`]));
writeFileSync(
  'dist/sea-config.json',
  JSON.stringify({ main: 'dist/jev-studio.cjs', output: 'dist/sea.blob', disableExperimentalSEAWarning: true, assets }, null, 2),
);
execFileSync(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json'], { stdio: 'inherit' });

console.log(`3/4 copying node to ${path.relative(root, exe)} ...`);
copyFileSync(process.execPath, exe);
// macOS refuses to modify a signed binary; the signature is put back (ad hoc) after the blob is injected.
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });

console.log('4/4 injecting the blob ...');
await postject.inject(exe, 'NODE_SEA_BLOB', readFileSync('dist/sea.blob'), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
});
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });

const mb = (statSync(exe).size / 1024 / 1024).toFixed(0);
console.log(`Done: ${path.relative(root, exe)} (${mb} MB, ${Object.keys(assets).length} UI files embedded)`);

// `--package` also writes what a release uploads to dist/release/: the .exe as it is, a .tar.gz for macOS and Linux
// (a plain download loses the executable bit, an archive keeps it), and a .sha256 next to each.
if (process.argv.includes('--package')) {
  const out = path.join(dist, 'release');
  mkdirSync(out, { recursive: true });
  const name = path.basename(exe);
  let asset = name;
  if (process.platform === 'win32') copyFileSync(exe, path.join(out, name));
  else {
    asset = `${name}.tar.gz`;
    execFileSync('tar', ['-czf', path.join(out, asset), '-C', dist, name]);
  }
  const sum = createHash('sha256').update(readFileSync(path.join(out, asset))).digest('hex');
  writeFileSync(path.join(out, `${asset}.sha256`), `${sum}  ${asset}\n`);
  console.log(`Packaged: dist/release/${asset} (+ .sha256)`);
}
