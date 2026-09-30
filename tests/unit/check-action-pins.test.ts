/**
 * #1517: nothing verified that every `uses:` ref in a workflow or composite
 * action stays pinned to a 40-hex SHA after the 2026-09 pin sweep (PR #1515).
 * scripts/check-action-pins.sh is the deterministic gate — this exercises it
 * against real fixture trees rather than reading its source, so a change to
 * the script's matching logic is proven, not just its presence in ci.yml.
 *
 * Two competing implementations of this script (#1517 on this branch, #2015
 * on main) landed on the same path; this merged suite exercises the kept
 * implementation's actual interface (positional DIR args, default `.github`,
 * exit 2 when nothing was scanned — the "a gate that scans zero files must
 * not report success" invariant) rather than either original in isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/check-action-pins.sh');
const SHA = '11d5960a326750d5838078e36cf38b85af677262';

function run(...dirs: string[]) {
  const r = spawnSync('bash', [SCRIPT, ...dirs], { encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'action-pins-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function workflow(name: string, body: string, filename = 'wf.yml'): string {
  const d = path.join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, filename), body);
  return d;
}

describe('check-action-pins.sh', () => {
  it("passes on this repo's own .github tree (positive control)", () => {
    const r = run();
    expect(r.out).toMatch(/all pinned/);
    expect(r.code).toBe(0);
  });

  it('accepts SHA pins (with a tag comment), local actions and digest-pinned docker', () => {
    const d = workflow(
      'ok',
      [
        'jobs:',
        '  a:',
        '    steps:',
        `      - uses: actions/checkout@${SHA} # v4`,
        `      - uses: "owner/repo/sub/path@${SHA}"`,
        '      - uses: ./.github/actions/local',
        `      - uses: docker://alpine@sha256:${'a'.repeat(64)}`,
      ].join('\n')
    );
    expect(run(d).code).toBe(0);
  });

  it.each([
    ['a tag', 'actions/checkout@v4'],
    ['a branch', 'some/action@main'],
    ['a branch named main on some-org/some-action', 'some-org/some-action@main'],
    ['a short SHA', 'actions/checkout@11d5960'],
    ['no ref at all', 'actions/checkout'],
    ['an unpinned docker image', 'docker://alpine:3'],
  ])('fails on %s', (_label, ref) => {
    const d = workflow(
      `bad-${ref.replace(/[^a-z0-9]/gi, '_')}`,
      `steps:\n  - name: x\n    uses: ${ref}\n`
    );
    const r = run(d);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`unpinned action ref: ${ref}`);
  });

  it('checks composite actions (action.yml) too, not just workflows', () => {
    const d = workflow(
      'composite',
      ['runs:', '  using: composite', '  steps:', '    - uses: actions/setup-node@v4'].join('\n'),
      'action.yml'
    );
    const r = run(d);
    expect(r.code).toBe(1);
    expect(r.out).toContain('action.yml');
    expect(r.out).toContain('unpinned action ref: actions/setup-node@v4');
  });

  it('fails (not passes) when there is nothing to scan', () => {
    expect(run(path.join(dir, 'does-not-exist')).code).toBe(2);
  });
});
