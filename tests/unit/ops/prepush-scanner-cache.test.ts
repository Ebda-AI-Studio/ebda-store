import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/ci/prepush-scanner-cache.sh (PREPUSH-5): pass cache keyed by HEAD tree + scanner list, clean tree ONLY.
const SCRIPT = join(__dirname, '../../../scripts/ci/prepush-scanner-cache.sh');
// The pre-push hook exports GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE; inherited, they would make these temp-repo git
// calls commit into the REAL checkout (observed 2026-11-11). Every spawn here scrubs them.
const cleanEnv = (extra: Record<string, string> = {}) => {
  const e: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const k of Object.keys(e))
    if (k.startsWith('GIT_') && k !== 'GIT_CONFIG_NOSYSTEM') delete e[k];
  return e as NodeJS.ProcessEnv;
};

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'psc-'));
  const cache = mkdtempSync(join(tmpdir(), 'psc-cache-'));
  const git = (...a: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, env: cleanEnv() });
  git('init', '-q');
  writeFileSync(join(cwd, '.gitignore'), 'dist/\n');
  writeFileSync(join(cwd, 'a.txt'), '1');
  git('add', 'a.txt', '.gitignore');
  git('commit', '-q', '-m', 'init');
  const sp = (mode: string, files: string[], key?: string) =>
    spawnSync('bash', [SCRIPT, mode, ...files], {
      cwd,
      encoding: 'utf8',
      env: cleanEnv({ PREPUSH_CACHE_DIR: cache, ...(key ? { PREPUSH_CACHE_KEY: key } : {}) }),
    });
  const run = (mode: string, ...files: string[]) => sp(mode, files).status;
  const out = (mode: string, ...files: string[]) => sp(mode, files).stdout.trim();
  const runKey = (mode: string, key: string, ...files: string[]) => sp(mode, files, key).status;
  return { cwd, git, run, out, runKey };
}

describe('prepush-scanner-cache.sh', () => {
  it('misses before a pass is recorded, hits on the same clean tree and list', () => {
    const r = repo();
    expect(r.run('check', 'x.test.ts')).toBe(1);
    expect(r.run('record', 'x.test.ts')).toBe(0);
    expect(r.run('check', 'x.test.ts')).toBe(0);
  });

  it('misses on a changed scanner list and on a changed tree', () => {
    const r = repo();
    r.run('record', 'x.test.ts');
    expect(r.run('check', 'x.test.ts', 'y.test.ts')).toBe(1);
    writeFileSync(join(r.cwd, 'a.txt'), '2');
    r.git('commit', '-q', '-am', 'change');
    expect(r.run('check', 'x.test.ts')).toBe(1);
  });

  it('a dirty tree (modified or untracked) never reads and never writes the cache', () => {
    const r = repo();
    r.run('record', 'x.test.ts');
    writeFileSync(join(r.cwd, 'new.txt'), 'untracked');
    expect(r.run('check', 'x.test.ts')).toBe(1); // would hit on a clean tree
    r.git('add', 'new.txt');
    r.git('commit', '-q', '-m', 'add');
    writeFileSync(join(r.cwd, 'a.txt'), 'dirty');
    expect(r.run('record', 'x.test.ts')).toBe(1); // dirty: nothing recorded
    r.git('checkout', 'a.txt');
    expect(r.run('check', 'x.test.ts')).toBe(1); // the new clean tree was never recorded
  });

  it('a changed GITIGNORED file (built dist the scanners import) is a cache miss', () => {
    const r = repo();
    mkdirSync(join(r.cwd, 'dist'));
    writeFileSync(join(r.cwd, 'dist', 'index.js'), 'v1');
    r.run('record', 'x.test.ts');
    expect(r.run('check', 'x.test.ts')).toBe(0); // clean tree, unchanged ignored input
    writeFileSync(join(r.cwd, 'dist', 'index.js'), 'version-2');
    expect(r.run('check', 'x.test.ts')).toBe(1);
    writeFileSync(join(r.cwd, 'dist', 'extra.js'), 'x');
    r.run('record', 'x.test.ts');
    rmSync(join(r.cwd, 'dist', 'extra.js'));
    expect(r.run('check', 'x.test.ts')).toBe(1);
  });

  it('records under the PRE-run key: a rebuild during the scan is not cached as a pass', () => {
    const r = repo();
    mkdirSync(join(r.cwd, 'dist'));
    writeFileSync(join(r.cwd, 'dist', 'index.js'), 'v1');
    const key = r.out('key', 'x.test.ts');
    expect(key).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(r.cwd, 'dist', 'index.js'), 'rebuilt-mid-scan'); // "scan" runs, dist changes
    expect(r.runKey('record', key, 'x.test.ts')).toBe(0);
    expect(r.run('check', 'x.test.ts')).toBe(1); // post-scan state was never validated
    writeFileSync(join(r.cwd, 'dist', 'index.js'), 'v1');
    expect(r.run('check', 'x.test.ts')).toBe(0); // the state that actually passed
  });

  it('small ignored files are hashed by content, not mtime (same bytes rewritten still hits)', () => {
    const r = repo();
    mkdirSync(join(r.cwd, 'dist'));
    writeFileSync(join(r.cwd, 'dist', 'meta.json'), '{"a":1}');
    r.run('record', 'x.test.ts');
    const later = new Date(Date.now() + 60_000);
    writeFileSync(join(r.cwd, 'dist', 'meta.json'), '{"a":1}');
    utimesSync(join(r.cwd, 'dist', 'meta.json'), later, later);
    expect(r.run('check', 'x.test.ts')).toBe(0);
    writeFileSync(join(r.cwd, 'dist', 'meta.json'), '{"a":2}'); // same size, new content
    expect(r.run('check', 'x.test.ts')).toBe(1);
  });
});
