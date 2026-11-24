// Ruling SLOP-VENDORED-1: the slop guard waives ONLY the `unused-export` rule, for exactly the vendored foundation folder, and only while
// foundation.lock.json proves every vendored file byte-matches the tagged release and the parity test exists. Every other rule still runs on
// vendored files. Fixture checkouts in a temp dir; the real repo config is asserted at the bottom.
// @ts-nocheck
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

  describe('trust boundary: the lock is PR-controlled (security review of SLOP-VENDORED-1)', () => {
    const cloneRoot = (from: string) => {
      const to = mkdtempSync(join(tmpdir(), 'pq-vend-pr-'));
      dirs.push(to);
      for (const rel of [
        `${DIR}/helpers.ts`,
        `${DIR}/loose.ts`,
        PARITY,
        'foundation.lock.json',
        'apps/api/src/own.ts',
      ]) {
        mkdirSync(dirname(join(to, rel)), { recursive: true });
        writeFileSync(join(to, rel), readFileSync(join(from, rel)));
      }
      return to;
    };
    const editLock = (root: string, fn: (l: any) => void) => {
      const f = join(root, 'foundation.lock.json');
      const l = JSON.parse(readFileSync(f, 'utf8'));
      fn(l);
      writeFileSync(f, JSON.stringify(l));
    };

    it('with --base-root, an unchanged lock keeps the exemption', () => {
      const { root: base, config } = checkout();
      const pr = cloneRoot(base);
      expect(vendoredExemption(pr, config, base).dir).toBe(DIR);
    });

    it('a PR that edits the lock AND a vendored file together gets NO exemption (it cannot waive its own code)', () => {
      const { root: base, config } = checkout();
      const pr = cloneRoot(base);
      const evil = 'export const SNEAKED_IN = 1;\n';
      writeFileSync(join(pr, `${DIR}/helpers.ts`), evil);
      editLock(pr, l => {
        l.files[`${DIR}/helpers.ts`] = sha(evil); // the lock now "proves" the edited file
      });
      // read from the PR alone the edit would pass; against the base it must not
      expect(vendoredExemption(pr, config).dir).toBe(DIR);
      const r = vendoredExemption(pr, config, base);
      expect(r.dir).toBeNull();
      expect(r.why).toContain('differs from the base');
      expect(
        ids(scan({ root: pr, config, baseRoot: base })).some(i =>
          i.includes(`unused-export|${DIR}/helpers.ts|SNEAKED_IN`)
        )
      ).toBe(true);
    });

    it('a PR that only touches the tag or commit in the lock gets no waiver either', () => {
      const { root: base, config } = checkout();
      const pr = cloneRoot(base);
      editLock(pr, l => {
        l.tag = 'v9.9.9';
      });
      expect(vendoredExemption(pr, config, base).dir).toBeNull();
    });

    it('a base without a lock has nothing to trust: no exemption', () => {
      const { root: base, config } = checkout();
      const pr = cloneRoot(base);
      rmSync(join(base, 'foundation.lock.json'));
      expect(vendoredExemption(pr, config, base).dir).toBeNull();
    });
  });

  describe('path safety: lock entries are data from the PR', () => {
    const withEntry = (rel: string) => {
      const { root, config } = checkout();
      const f = join(root, 'foundation.lock.json');
      const l = JSON.parse(readFileSync(f, 'utf8'));
      l.files[rel] = 'f'.repeat(64);
      writeFileSync(f, JSON.stringify(l));
      return vendoredExemption(root, config);
    };
    it.each([
      [`${DIR}/../../../../etc/passwd`, 'dot-dot under dir'],
      ['../outside.ts', 'leading dot-dot'],
      ['/etc/passwd', 'absolute'],
      [`${DIR}/a\\..\\b.ts`, 'backslash'],
      ['', 'empty'],
    ])('rejects the lock entry %j (%s) before touching the file system', rel => {
      const r = withEntry(rel);
      expect(r.dir).toBeNull();
      expect(r.why).toMatch(/not a safe relative path|escapes/);
    });
    it('rejects a lock whose dir is absolute or climbs out of the repo', () => {
      for (const dir of ['/tmp', '../x', 'packages/../../x']) {
        const { root, config } = checkout();
        const f = join(root, 'foundation.lock.json');
        const l = JSON.parse(readFileSync(f, 'utf8'));
        l.dir = dir;
        writeFileSync(f, JSON.stringify(l));
        config.ruleExemptions[0].path = dir;
        expect(vendoredExemption(root, config).dir).toBeNull();
      }
    });
    it('a normal lock still passes', () => {
      const { root, config } = checkout();
      expect(vendoredExemption(root, config).dir).toBe(DIR);
    });
  });

  it('without a lock file there is no exemption', () => {
    const { root, config } = checkout();
    rmSync(join(root, 'foundation.lock.json'));
    expect(vendoredExemption(root, config).dir).toBeNull();
  });

  it('an old baseline entry for a waived vendored export is ignored, not reported as fixed-but-listed (no later PR has to rewrite it)', () => {
    const { root, config } = checkout();
    writeFileSync(join(root, '.pr-quality.json'), JSON.stringify(config));
    const ids = [...scan({ root, config }).keys()];
    writeFileSync(
      join(root, '.pr-quality-baseline.json'),
      JSON.stringify({ ids: [...ids, `unused-export|${DIR}/helpers.ts|UNUSED_VENDORED`] })
    );
    const guard = join(__dirname, '../../.github/pr-quality/slop-guard.mjs');
    const ok = spawnSync(process.execPath, [guard, '--root', root], { encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    // with the parity test gone the waiver is off: the vendored export counts again and the listed id is honoured
    rmSync(join(root, PARITY));
    const off = spawnSync(process.execPath, [guard, '--root', root], { encoding: 'utf8' });
    expect(off.stderr).toMatch(/OFF/);
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
