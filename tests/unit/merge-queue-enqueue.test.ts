/** MERGE-QUEUE-1: the enqueue step refuses a moved head, passes the pinned sha to GitHub, and ci.yml reports merge_group. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO, 'scripts/ci/merge-queue-enqueue.sh');
const SHA = 'a'.repeat(40);

function fakeGh(view: string, graphqlExit = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mq-'));
  const gh = path.join(dir, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bash\necho "$@" >> "${dir}/calls"\nif [ "$1" = pr ]; then printf '%s' '${view}'; exit 0; fi\nif [ "$1" = api ]; then echo '{"data":"x"}'; exit ${graphqlExit}; fi\n`
  );
  chmodSync(gh, 0o755);
  return { gh, calls: () => readFileSync(path.join(dir, 'calls'), 'utf8') };
}
const run = (gh: string, sha = SHA) =>
  spawnSync('bash', [SCRIPT, 'o/r', '5', sha], {
    encoding: 'utf8',
    env: { ...process.env, MERGE_QUEUE_GH: gh },
  });

describe('merge-queue-enqueue.sh', () => {
  it('enqueues with expectedHeadOid = the verified sha', () => {
    const f = fakeGh('PR_node');
    const r = run(f.gh);
    expect(r.status).toBe(0);
    expect(f.calls()).toContain(`oid=${SHA}`);
    expect(f.calls()).toContain('enqueuePullRequest');
  });
  it('refuses, without calling GraphQL, when the PR is not open at that head', () => {
    const f = fakeGh('');
    const r = run(f.gh);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not open at head');
    expect(f.calls()).not.toContain('enqueuePullRequest');
  });
  it('refuses a malformed sha before touching gh', () => {
    const f = fakeGh('PR_node');
    expect(run(f.gh, 'abc').status).toBe(1);
  });
  it('surfaces GitHub refusing the enqueue as a non-zero exit', () => {
    expect(run(fakeGh('PR_node', 1).gh).status).toBe(1);
  });
});

describe('ci.yml merge_group wiring', () => {
  const yml = readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
  it('triggers on merge_group checks_requested', () =>
    expect(yml).toMatch(/\n {2}merge_group:\n {4}types: \[checks_requested\]/));
  it('gives a queue group its own never-cancelled concurrency group', () => {
    expect(yml).toContain("github.event_name == 'merge_group' && format('mq-{0}', github.sha)");
    expect(yml).toMatch(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \|\|/);
  });
  it('does not page "main is red" for a failed queue group', () =>
    expect(yml).toMatch(
      /if: always\(\) && !cancelled\(\) && github\.event_name != 'pull_request' && github\.event_name != 'merge_group'/
    ));
});
