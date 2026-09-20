// Starts a built executable and checks it really works on its own: it serves the UI it carries inside itself,
// answers /api/status, and stores a key encrypted. Usage: node scripts/smoke.mjs dist/jev-studio-linux-x64
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exe = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node scripts/smoke.mjs <path-to-executable>');

const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const home = mkdtempSync(path.join(tmpdir(), 'jev-smoke-'));
// Point every OS's app-data lookup at a scratch folder so the test never touches a real key.
const env = { ...process.env, PORT: String(port), TYPESAFE_API_KEY: '', APPDATA: home, HOME: home, XDG_CONFIG_HOME: path.join(home, 'cfg') };

const child = spawn(exe, ['--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      return await fetch(`${base}/api/status`);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`The executable never started listening.\n${log}`);
}

try {
  const status = await (await waitUp()).json();
  assert.equal(status.keySource, 'none');

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Jev Studio/, 'serves the UI embedded in the executable');
  assert.equal((await fetch(`${base}/ui/apikey.js`)).status, 200, 'serves nested embedded files');
  assert.equal((await fetch(`${base}/nope.js`)).status, 404);

  const key = 'ts_live_smoketest0123456789';
  const saved = await fetch(`${base}/api/key`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  const after = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(after.keySource, 'stored');
  assert.equal(JSON.stringify(after).includes(key), false, 'the key is not sent back');

  const file = [path.join(home, 'Jev Studio', 'apikey.enc'), path.join(home, 'Library', 'Application Support', 'Jev Studio', 'apikey.enc'), path.join(home, 'cfg', 'jev-studio', 'apikey.enc')]
    .map((f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } })
    .find(Boolean);
  assert.ok(file, 'an encrypted key file was written to the app data folder');
  assert.equal(file.includes(key), false, 'the key on disk is encrypted');
  console.log(`smoke test passed (${path.basename(exe)})`);
} catch (err) {
  console.error(err, '\n--- executable output ---\n' + log);
  process.exitCode = 1;
} finally {
  child.kill();
  rmSync(home, { recursive: true, force: true });
}
