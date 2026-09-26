/**
 * #1517 — scripts/check-action-pins.sh fails on any GitHub Action not pinned
 * to a full commit SHA, and passes on the repo's own workflows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

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

function workflow(name: string, body: string): string {
  const d = path.join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'wf.yml'), body);
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

  it('fails (not passes) when there is nothing to scan', () => {
    expect(run(path.join(dir, 'does-not-exist')).code).toBe(2);
  });
});
