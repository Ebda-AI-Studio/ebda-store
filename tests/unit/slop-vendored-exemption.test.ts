// Ruling SLOP-VENDORED-1: the slop guard waives ONLY the `unused-export` rule, for exactly the vendored foundation folder, and only while
// foundation.lock.json proves every vendored file byte-matches the tagged release and the parity test exists. Every other rule still runs on
// vendored files. Fixture checkouts in a temp dir; the real repo config is asserted at the bottom.
// @ts-nocheck
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scan, vendoredExemption } from '../../.github/pr-quality/slop-guard.mjs';

const DIR = 'packages/shared/src/foundation';
const PARITY = 'tests/unit/foundation-parity.test.ts';
const sha = s => createHash('sha256').update(s).digest('hex');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function checkout(
  over: { vendored?: Record<string, string>; skipParity?: boolean; ruleExemptions?: unknown } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'pq-vend-'));
  dirs.push(root);
  const files: Record<string, string> = {
    [`${DIR}/helpers.ts`]: 'export const UNUSED_VENDORED = 1;\n',
    [`${DIR}/loose.ts`]: 'export function looseAny(x: any) { return x; }\n',
    ...over.vendored,
  };
  const lockFiles: Record<string, string> = {};
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    lockFiles[rel] = sha(text);
  }
  if (!over.skipParity) {
    mkdirSync(join(root, 'tests/unit'), { recursive: true });
    writeFileSync(join(root, PARITY), '// parity\n');
  }
  lockFiles[PARITY] = sha('// parity\n');
  writeFileSync(
    join(root, 'foundation.lock.json'),
    JSON.stringify({
      tag: 'v0.3.1',
      commit: 'a'.repeat(40),
      dir: DIR,
      parity: PARITY,
      files: lockFiles,
    })
  );
  mkdirSync(join(root, 'apps/api/src'), { recursive: true });
  writeFileSync(join(root, 'apps/api/src/own.ts'), 'export const OWN_UNUSED = 2;\n');
  const config = {
    roots: ['apps', 'packages'],
    ruleExemptions: over.ruleExemptions ?? [
      {
        rule: 'unused-export',
        path: DIR,
        reason: 'vendored foundation, byte-pinned by foundation.lock.json and the parity test',
        requires: PARITY,
      },
    ],
  };
  return { root, config };
}
const ids = (m: Map<string, string>) => [...m.keys()];

describe('SLOP-VENDORED-1', () => {
  it('waives unused-export for the vendored folder, but not for our own code', () => {
    const { root, config } = checkout();
    const found = ids(scan({ root, config }));
    expect(found.some(i => i.startsWith(`unused-export|${DIR}/`))).toBe(false);
    expect(found.some(i => i.includes('apps/api/src/own.ts|OWN_UNUSED'))).toBe(true);
    expect(vendoredExemption(root, config).dir).toBe(DIR);
  });

  it('no other rule is waived: no-any still fires inside the vendored folder', () => {
    const { root, config } = checkout();
    expect(
      ids(scan({ root, config })).some(
        i => i.startsWith('no-any|') && i.includes(`${DIR}/loose.ts`)
      )
    ).toBe(true);
  });

  it('the exemption is OFF when the parity test is removed', () => {
    const { root, config } = checkout({ skipParity: true });
    expect(vendoredExemption(root, config)).toMatchObject({ dir: null });
    expect(ids(scan({ root, config })).some(i => i.startsWith(`unused-export|${DIR}/`))).toBe(true);
  });

  it('the exemption is OFF when the path widens beyond the vendored folder', () => {
    for (const path of ['packages', 'packages/shared', 'packages/shared/src', `${DIR}/`, '.']) {
      const { root, config } = checkout({
        ruleExemptions: [
          {
            rule: 'unused-export',
            path,
            reason: 'too wide to be a real reason here',
            requires: PARITY,
          },
        ],
      });
      expect(vendoredExemption(root, config).dir, path).toBeNull();
      expect(
        ids(scan({ root, config })).some(i => i.startsWith(`unused-export|${DIR}/`)),
        path
      ).toBe(true);
    }
  });

  it('the exemption is OFF for any other rule, a second entry, a short reason or a different parity file', () => {
    const base = { path: DIR, reason: 'a perfectly real reason for the test', requires: PARITY };
    for (const entries of [
      [{ ...base, rule: 'no-any' }],
      [
        { ...base, rule: 'unused-export' },
        { ...base, rule: 'unused-export' },
      ],
      [{ ...base, rule: 'unused-export', reason: 'short' }],
      [{ ...base, rule: 'unused-export', requires: 'tests/unit/other.test.ts' }],
    ]) {
      const { root, config } = checkout({ ruleExemptions: entries });
      expect(vendoredExemption(root, config).dir).toBeNull();
    }
  });

  it('the exemption is OFF when a vendored file no longer byte-matches the lock, or an unlocked file appears', () => {
    const a = checkout();
    writeFileSync(
      join(a.root, `${DIR}/helpers.ts`),
      'export const UNUSED_VENDORED = 1; // edited\n'
    );
    expect(vendoredExemption(a.root, a.config)).toMatchObject({ dir: null });
    expect(
      ids(scan({ root: a.root, config: a.config })).some(i => i.startsWith(`unused-export|${DIR}/`))
    ).toBe(true);
    const b = checkout();
    writeFileSync(join(b.root, `${DIR}/extra.ts`), 'export const EXTRA = 3;\n');
    expect(vendoredExemption(b.root, b.config).why).toMatch(/not in the lock/);
  });

  it('without a lock file there is no exemption', () => {
    const { root, config } = checkout();
    rmSync(join(root, 'foundation.lock.json'));
    expect(vendoredExemption(root, config).dir).toBeNull();
  });

  it('the real repo: exactly one narrow entry, and the real vendored files match the lock', () => {
    const cfg = JSON.parse(readFileSync(join(__dirname, '../../.pr-quality.json'), 'utf8'));
    expect(cfg.skip).toBeUndefined(); // no whole-folder skip, ever
    expect(cfg.ruleExemptions).toHaveLength(1);
    expect(cfg.ruleExemptions[0]).toMatchObject({
      rule: 'unused-export',
      path: DIR,
      requires: PARITY,
    });
    expect(vendoredExemption(join(__dirname, '../..'), cfg)).toMatchObject({ dir: DIR });
  });
});
