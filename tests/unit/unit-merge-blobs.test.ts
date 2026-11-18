/**
 * Ruling UNIT-MERGE-ROOTS-1: the unit merge job re-roots the shard blobs onto its own checkout and then checks that no shard was dropped.
 * Evidence: group run 44343978493 (all shards on one runner, merge on another: "No test files found", exit 1) and group run 44326426543
 * (mixed roots: 1386 of 2083 test files merged, one shard silently dropped).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
// @ts-expect-error plain ESM module without types
import {
  rerootText,
  blobFileCount,
  mergedFileTotal,
  reroot,
  check,
} from '../../scripts/ci/unit-merge-blobs.mjs';

const SCRIPT = join(__dirname, '../../scripts/ci/unit-merge-blobs.mjs');
const A = '/Users/ahmadsharaf/actions-runner-ebda/_work/ebda-store/ebda-store';
const B = '/Users/ahmadsharaf/actions-runner-ebda-2/_work/ebda-store/ebda-store';

/** A vitest-shaped blob: [refs, version, files, errors, {path: ref}, ...] with `n` test files rooted at `root`. */
function blob(root: string, n: number): string {
  const files = Array.from({ length: n }, (_, i) => String(i + 6));
  const paths: Record<string, string> = {};
  for (let i = 0; i < n; i++) paths[`${root}/tests/unit/f${i}.test.ts`] = String(i);
  return JSON.stringify([
    ['1', '2', '3', '4', 1, '5'],
    '4.1.12',
    files,
    [],
    paths,
    { '': '1' },
    `at x (${root}/src/a.ts:1:1)`,
  ]);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'umb-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('rerootText', () => {
  it('rewrites a runner workspace root, in path keys, values and error text, and leaves other paths and messages alone', () => {
    const t = `{"${A}/tests/x.ts":1,"s":"at f (${A}/src/y.ts:2:3)","other":"/usr/lib/node/z.js","msg":"Error at /foo/bar (${B}/a.ts)"}`;
    const { text, n } = rerootText(t, '/work/co');
    expect(n).toBe(3);
    expect(text).toContain('"/work/co/tests/x.ts"');
    expect(text).toContain('at f (/work/co/src/y.ts:2:3)');
    expect(text).toContain('"/usr/lib/node/z.js"'); // not a runner root
    expect(text).toContain('Error at /foo/bar (/work/co/a.ts)'); // the earlier path in the same string is untouched
  });
  it('is idempotent on an already re-rooted blob', () => {
    const once = rerootText(blob(A, 2), B).text;
    expect(rerootText(once, B).text).toBe(once);
  });
});

describe('the mixed-root merge (the production failure)', () => {
  it('reroot moves EVERY blob under the merge root, whichever runner it came from, and refuses a blob with nothing to rewrite', () => {
    writeFileSync(join(dir, 'blob-1-3.json'), blob(A, 3));
    writeFileSync(join(dir, 'blob-2-3.json'), blob(B, 2));
    reroot(dir, B);
    for (const f of ['blob-1-3.json', 'blob-2-3.json']) {
      const s = readFileSync(join(dir, f), 'utf8');
      expect(s).not.toContain('actions-runner-ebda/');
      expect(s).toContain(`${B}/tests/unit/f0.test.ts`);
    }
    writeFileSync(join(dir, 'blob-3-3.json'), JSON.stringify([[], 'v', [], [], {}]));
    expect(() => reroot(dir, B)).toThrow(/blob-3-3\.json: no runner workspace root/);
  });
  it('the CLI exits 1 with a ::error:: line on a missing directory argument', () => {
    const r = spawnSync('node', [SCRIPT, 'reroot'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('::error::unit-merge-blobs');
  });
});

describe('check: merged test files must equal the sum of the shards', () => {
  const log = (n: number) =>
    ` Test Files  ${n - 3} passed | 3 skipped (${n})\n      Tests  10 passed (10)\n`;
  it('counts blob[2] per shard and the (N) of the merged "Test Files" line', () => {
    expect(blobFileCount(JSON.parse(blob(A, 4)))).toBe(4);
    expect(mergedFileTotal(log(2083))).toBe(2083);
    expect(mergedFileTotal('no summary here')).toBeNull();
  });
  it('passes when they are equal and FAILS when a shard was dropped (1386+... vs 2083), or when there is no summary', () => {
    writeFileSync(join(dir, 'blob-1-3.json'), blob(A, 695));
    writeFileSync(join(dir, 'blob-2-3.json'), blob(A, 694));
    writeFileSync(join(dir, 'blob-3-3.json'), blob(A, 694));
    expect(check(dir, log(2083))).toBe(2083);
    expect(() => check(dir, log(1389))).toThrow(
      /1389 test files but the 3 shard blobs carry 2083: 694 test file\(s\) were DROPPED/
    );
    expect(() => check(dir, 'no summary')).toThrow(/no "Test Files/);
  });
  it('the CLI check exits 1 on a mismatch and 0 on a match', () => {
    writeFileSync(join(dir, 'b.json'), blob(A, 5));
    writeFileSync(join(dir, 'ok.log'), log(5));
    writeFileSync(join(dir, 'bad.log'), log(4));
    expect(() =>
      execFileSync('node', [SCRIPT, 'check', dir, join(dir, 'ok.log')], { encoding: 'utf8' })
    ).not.toThrow();
    const r = spawnSync('node', [SCRIPT, 'check', dir, join(dir, 'bad.log')], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('DROPPED');
  });
});

describe('ci.yml wiring', () => {
  const doc = yaml.load(
    readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8')
  ) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const steps = Object.values(doc.jobs).flatMap(j => j.steps ?? []);
  const idx = (re: RegExp) => steps.findIndex(s => re.test(s.run ?? ''));
  it('the shard blobs are re-rooted BEFORE the merge, and the file-count check runs AFTER it on the merge log', () => {
    const rr = idx(/unit-merge-blobs\.mjs reroot \.vitest-reports "\$GITHUB_WORKSPACE"/);
    const mg = idx(/vitest run --merge-reports/);
    const ck = idx(/unit-merge-blobs\.mjs check \.vitest-reports /);
    expect(rr, 'reroot step').toBeGreaterThan(-1);
    expect(mg).toBeGreaterThan(rr);
    expect(ck).toBeGreaterThan(mg);
    expect(steps[mg]?.run).toMatch(/pipefail/);
    expect(steps[mg]?.run).toMatch(/tee "\$RUNNER_TEMP\/unit-merge\.log"/);
    expect(steps[ck]?.run).toContain('"$RUNNER_TEMP/unit-merge.log"');
  });
});
