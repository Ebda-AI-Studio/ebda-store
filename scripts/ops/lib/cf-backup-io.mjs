// Real + local implementations of the `io` the backup/drill libraries take (see cf-backup.mjs).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertPlatformTables,
  digestSqlite,
  exportStoreOverHttp,
  decodeKeychainSecret,
} from './cf-backup.mjs';

export const BUCKET = 'ebda-db-backups';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: opts.binary ? 'buffer' : 'utf8',
    maxBuffer: 1 << 30,
    ...opts,
  });
  if (r.error) throw r.error;
  return r;
}

export function ageEncrypt(recipient) {
  return buf => {
    const r = run('age', ['-r', recipient], { input: buf, binary: true });
    if (r.status !== 0) throw new Error(`age encrypt failed: ${r.stderr}`);
    return r.stdout;
  };
}
/** identityText = the age secret key file contents (already hex-decoded if it came from the macOS Keychain). */
export function ageDecrypt(identityText) {
  const dir = mkdtempSync(path.join(tmpdir(), 'age-id-'));
  const file = path.join(dir, 'identity.txt');
  writeFileSync(file, identityText, { mode: 0o600 });
  return buf => {
    const r = run('age', ['-d', '-i', file], { input: buf, binary: true });
    if (r.status !== 0) throw new Error(`age decrypt failed: ${r.stderr}`);
    return r.stdout;
  };
}
export const identityFromKeychain = service => {
  const r = run('security', ['find-generic-password', '-s', service, '-w']);
  if (r.status !== 0) throw new Error(`keychain item ${service} not found`);
  return decodeKeychainSecret(r.stdout);
};

/** R2 through wrangler (account token in the env). READ-ONLY variant has no put. */
export function wranglerR2({
  bucket = BUCKET,
  readOnly = false,
  wrangler = ['npx', 'wrangler'],
} = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'r2-'));
  const w = (args, o) => run(wrangler[0], [...wrangler.slice(1), ...args], o);
  return {
    async r2Get(key) {
      const f = path.join(tmp, 'get.bin');
      rmSync(f, { force: true });
      const r = w(['r2', 'object', 'get', `${bucket}/${key}`, '--file', f, '--remote']);
      if (r.status === 0) return readFileSync(f);
      if (/not exist|NoSuchKey|404/i.test(`${r.stderr}${r.stdout}`)) return null;
      throw new Error(`r2 get ${key} failed: ${r.stderr || r.stdout}`);
    },
    async r2Put(key, buf) {
      if (readOnly) throw new Error('read-only R2: refusing to write');
      const f = path.join(tmp, 'put.bin');
      writeFileSync(f, buf);
      const r = w(['r2', 'object', 'put', `${bucket}/${key}`, '--file', f, '--remote']);
      if (r.status !== 0) throw new Error(`r2 put ${key} failed: ${r.stderr || r.stdout}`);
    },
  };
}

/** A directory standing in for the bucket (the weekly fixture drill and the tests). */
export function dirR2(root) {
  return {
    async r2Get(key) {
      const f = path.join(root, key);
      return existsSync(f) ? readFileSync(f) : null;
    },
    async r2Put(key, buf) {
      const f = path.join(root, key);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, buf);
    },
  };
}

export async function d1Digests(sqlText) {
  const db = new DatabaseSync(':memory:');
  try {
    // `wrangler d1 export` writes tables alphabetically with their rows interleaved, so a child's INSERT can precede its parent's
    // CREATE TABLE. D1 itself defers foreign keys while importing; node:sqlite enforces them by default and fails with
    // "no such table: main.stores" (the first real nightly run, 2026-11-05). Constraints are a property of the source, not of this read.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(sqlText);
    return await digestSqlite(db);
  } finally {
    db.close();
  }
}

export function realBackupIo({ recipient, apiUrl, secret, d1Name = 'ebda-platform', r2 }) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cfbk-'));
  const wr = args => run('npx', ['wrangler', ...args]);
  return {
    ...r2,
    encrypt: ageEncrypt(recipient),
    async exportD1() {
      const out = path.join(tmp, 'd1.sql');
      const r = wr(['d1', 'export', d1Name, '--remote', '--output', out]);
      if (r.status !== 0) throw new Error(`d1 export failed: ${r.stderr || r.stdout}`);
      const raw = readFileSync(out);
      return { raw, tables: assertPlatformTables(await d1Digests(raw.toString('utf8'))) };
    },
    async listStoreIds() {
      const r = wr([
        'd1',
        'execute',
        d1Name,
        '--remote',
        '--json',
        '--command',
        "SELECT id FROM stores WHERE storage_backend = 'do' ORDER BY id",
      ]);
      if (r.status !== 0) throw new Error(`store list failed: ${r.stderr || r.stdout}`);
      const j = JSON.parse(r.stdout);
      return (j[0]?.results ?? []).map(x => x.id);
    },
    async exportStore(id) {
      const call = async (p, body) => {
        const res = await fetch(apiUrl + p, {
          method: body ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(120_000),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.ok === false) throw new Error(`${p}: HTTP ${res.status} ${j.error ?? ''}`);
        return j;
      };
      return exportStoreOverHttp(call, id);
    },
  };
}
