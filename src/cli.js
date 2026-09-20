import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.js';
import { createKeyStore } from './keystore.js';
import { isPackaged } from './assets.js';
import { loadDotEnv } from './env.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const mock = flag('--mock');
const packaged = isPackaged();

// Running from source, a .env file in the project folder can hold the key (and beats the environment).
// The packaged app has no project folder: it uses the key saved in the app, or TYPESAFE_API_KEY.
let dotEnvKeys = [];
if (!packaged) dotEnvKeys = loadDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'));
const keyFromFile = dotEnvKeys.includes('TYPESAFE_API_KEY');
const keySource = keyFromFile ? '.env' : process.env.TYPESAFE_API_KEY ? 'environment' : 'none';

const port = Number(process.env.PORT) || 3000;
const url = `http://localhost:${port}`;
const open = packaged && !flag('--no-open'); // a source run leaves the browser to you, as it always has

/** Open a URL in the default browser. Failure is not fatal: the address is printed too. */
function openBrowser(target) {
  const [cmd, cmdArgs] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
    : process.platform === 'darwin' ? ['open', [target]]
    : ['xdg-open', [target]];
  const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

/** Is whatever holds the port another copy of this app? (Then opening it is better than failing.) */
async function alreadyRunning() {
  try {
    const res = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).model !== undefined;
  } catch {
    return false;
  }
}

const server = createApp({ mock, keySource, keyStore: createKeyStore() });

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(err.message);
    process.exit(1);
  }
  if (await alreadyRunning()) {
    console.log(`Jev Studio is already running at ${url}.`);
    if (open) openBrowser(url);
    process.exit(0);
  }
  console.error(`Port ${port} is in use by something else. Set PORT to another value.`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Jev Studio is running at ${url}`);
  if (packaged) console.log('Close this window (or press Ctrl+C) to quit.');
  if (mock) console.log('Mock mode: answers are sample data, no API calls are made.');
  else if (keySource === 'none') console.log('No API key from the environment. Add one under "API key…" in the app.');
  if (open) openBrowser(url);
});
