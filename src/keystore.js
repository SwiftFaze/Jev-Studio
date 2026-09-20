import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The API key is kept in one small file in the app's data folder, encrypted with AES-256-GCM. The encryption key is
// derived (scrypt, with a random salt stored in the file) from this machine's ID and the OS user name, so the file is
// useless if copied to another computer or account. It is not protected from other programs running as you on this
// machine: without an OS keychain nothing in the same account can be kept apart from the app itself.

const FILE_NAME = 'apikey.enc';
const AAD = Buffer.from('jev-studio:apikey:v1');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Where per-user app data lives on this OS. */
export function appDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Jev Studio');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Jev Studio');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'jev-studio');
}

/** A stable per-machine identifier, or the host name when the OS will not give one. */
function machineId() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true });
      const id = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1];
      if (id) return id;
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      const id = /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1];
      if (id) return id;
    } else {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = readFileSync(file, 'utf8').trim();
          if (id) return id;
        } catch {
          /* try the next location */
        }
      }
    }
  } catch {
    /* fall through to the host name */
  }
  return os.hostname();
}

/** The secret the encryption key is derived from. */
export const machineSecret = () => `jev-studio|${machineId()}|${os.userInfo().username}`;

/**
 * An encrypted, single-value store for the API key. `secret` is a string or a function returning one (called only
 * when a key is read or written, so nothing is looked up at startup). The decrypted key is cached in memory.
 */
export function createKeyStore({ dir = appDataDir(), secret = machineSecret } = {}) {
  const file = path.join(dir, FILE_NAME);
  let cache; // undefined = not read yet, otherwise the result of read()
  const secretText = () => (typeof secret === 'function' ? secret() : secret);
  const derive = (salt) => scryptSync(secretText(), salt, 32, SCRYPT);

  function readFromDisk() {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { status: 'none' };
      return { status: 'unreadable' };
    }
    try {
      const { v, salt, iv, tag, data } = JSON.parse(raw);
      if (v !== 1) return { status: 'unreadable' };
      const decipher = createDecipheriv('aes-256-gcm', derive(Buffer.from(salt, 'base64')), Buffer.from(iv, 'base64'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const key = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
      return key ? { status: 'ok', key } : { status: 'unreadable' };
    } catch {
      // Corrupt file, or written on another machine or by another user: it cannot be decrypted here.
      return { status: 'unreadable' };
    }
  }

  return {
    file,

    /** `{ status: 'none' }`, `{ status: 'ok', key }`, or `{ status: 'unreadable' }` (present but cannot be decrypted here). */
    read() {
      cache ??= readFromDisk();
      return cache;
    },

    /** Encrypt and save the key, replacing any earlier one. Written to a temporary file first so a crash cannot leave half a key. */
    write(key) {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', derive(salt), iv);
      cipher.setAAD(AAD);
      const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
      const payload = { v: 1, alg: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };

      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      renameSync(tmp, file);
      cache = { status: 'ok', key };
    },

    /** Delete the stored key (also an unreadable one). A missing file is not an error. */
    remove() {
      rmSync(file, { force: true });
      cache = { status: 'none' };
    },
  };
}
