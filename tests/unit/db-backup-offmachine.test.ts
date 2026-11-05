/**
 * OPS-7 / M-011: the verifier must refuse a dump that restores nothing (2026-09-17: valid gzip around zero bytes). The
 * db-backup.yml workflow assertions went with the workflow (Ruling NZ-17-BACKUP-1).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const VERIFY = path.join(ROOT, 'scripts/ops/verify-db-dump.sh');

function verify(opts: { bytes: number; toc: string[]; env?: Record<string, string> }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbv-'));
  const dump = path.join(dir, 'x.dump');
  writeFileSync(dump, Buffer.alloc(opts.bytes, 1));
  const fake = path.join(dir, 'pg_restore');
  writeFileSync(fake, `#!/bin/sh\ncat <<'TOC'\n${opts.toc.join('\n')}\nTOC\n`);
  chmodSync(fake, 0o755);
  const r = spawnSync('bash', [VERIFY, dump], {
    env: { ...process.env, PG_RESTORE: fake, ...opts.env },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout + r.stderr };
}
const tables = (n: number, names = ['stores', 'orders', 'users']) => [
  ...names.map((t, i) => `${i}; 0 1 TABLE DATA public ${t} owner`),
  ...Array.from({ length: n }, (_, i) => `${100 + i}; 0 1 TABLE DATA public t${i} owner`),
];

describe('verify-db-dump.sh', () => {
  it('accepts a plausible dump', () => {
    const r = verify({ bytes: 300_000, toc: tables(80) });
    expect(r.status).toBe(0);
    expect(r.out).toContain('ok');
  });
  it('refuses an empty-ish file', () => {
    expect(verify({ bytes: 20, toc: tables(80) }).status).toBe(1);
  });
  it('refuses a dump whose table of contents has too few tables', () => {
    expect(verify({ bytes: 300_000, toc: tables(5) }).status).toBe(1);
  });
  it('refuses a dump with no data for stores, orders or users', () => {
    const r = verify({ bytes: 300_000, toc: tables(80, ['stores', 'orders']) });
    expect(r.status).toBe(1);
    expect(r.out).toContain('users');
  });
  it('refuses when pg_restore cannot read it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dbv-'));
    const dump = path.join(dir, 'x.dump');
    writeFileSync(dump, Buffer.alloc(300_000, 1));
    const bad = path.join(dir, 'pg_restore');
    writeFileSync(bad, '#!/bin/sh\nexit 1\n');
    chmodSync(bad, 0o755);
    const r = spawnSync('bash', [VERIFY, dump], {
      env: { ...process.env, PG_RESTORE: bad },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
  });
});
