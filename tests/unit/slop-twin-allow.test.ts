// Ruling SLOP-TWIN-1: the slop guard accepts a deliberate byte-equal twin ONLY as a pair: the named twin file exists, has the same
// function with an identical body, and carries the matching `pq-allow(duplicate-helper): twin of <path>` pointing back.
// @ts-nocheck
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scan } from '../../.github/pr-quality/slop-guard.mjs';

const A = 'packages/repo/src/rev.ts';
const B = 'apps/api/src/lib/rev.ts';
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const BODY = `(alias: string, dialect: string): string {
  const parts = ['one', 'two', 'three', 'four', 'five'];
  const joined = parts.map(p => alias + '.' + p).join(', ');
  return dialect === 'pg' ? 'LEAST(' + joined + ')' : 'MIN(' + joined + ')';
}`;
const fn = (twin: string | null, body = BODY) =>
  `${twin ? `// pq-allow(duplicate-helper): twin of ${twin}; API cannot import packages/repo\n` : ''}export function sharedSqlHelper${body}\n`;

function checkout(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'pq-twin-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
const dup = (root: string) =>
  [...scan({ root, config: { roots: ['apps', 'packages'] } }).keys()].filter(id =>
    id.startsWith('duplicate-helper|')
  );
// every file must reference the helper so unused-export noise stays out of the way
const used = {
  'apps/api/src/use.ts':
    "import { sharedSqlHelper } from './lib/rev';\nexport const a = sharedSqlHelper;\n",
};

describe('SLOP-TWIN-1 duplicate-helper twin annotation', () => {
  it('an un-annotated duplicate still fails (both copies)', () => {
    const root = checkout({ [A]: fn(null), [B]: fn(null), ...used });
    expect(dup(root)).toHaveLength(2);
  });

  it('an accepted pair: both annotated, twin exists, identical body, pointing back', () => {
    const root = checkout({ [A]: fn(B), [B]: fn(A), ...used });
    expect(dup(root)).toEqual([]);
  });

  it('a missing back-reference fails (the twin is not annotated)', () => {
    const root = checkout({ [A]: fn(B), [B]: fn(null), ...used });
    expect(dup(root).length).toBeGreaterThan(0);
  });

  it('a back-reference that names a different file fails', () => {
    const root = checkout({ [A]: fn(B), [B]: fn('packages/other/x.ts'), ...used });
    expect(dup(root).length).toBeGreaterThan(0);
  });

  it('body drift fails: an annotated pair whose bodies no longer match is flagged', () => {
    const drifted = BODY.replace("'five'", "'six'");
    const root = checkout({ [A]: fn(B), [B]: fn(A, drifted), ...used });
    const ids = dup(root);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some(i => i.endsWith('|twin-invalid'))).toBe(true);
  });

  it('a twin file that does not exist fails', () => {
    const root = checkout({ [A]: fn('apps/api/src/lib/missing.ts'), ...used });
    expect(dup(root).some(i => i.endsWith('|twin-invalid'))).toBe(true);
  });

  it('a third un-annotated copy is still flagged while the annotated pair is accepted', () => {
    const C = 'packages/repo/src/third.ts';
    const root = checkout({ [A]: fn(B), [B]: fn(A), [C]: fn(null), ...used });
    const ids = dup(root);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toContain(`|${C}|`);
  });
});
