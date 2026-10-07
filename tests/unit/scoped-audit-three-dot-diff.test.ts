/**
 * #1763: scripts/scoped-audit.sh collapsed base...head (three-dot, merge-base
 * semantics) to a two-dot diff at both the changed-file-list site and the
 * diff-content site, by splitting PR_REF on `..` and handing git two separate
 * positional refs. `git diff A B` always computes a direct two-commit diff
 * regardless of how many dots separated them originally — so a branch that
 * was merely BEHIND main (never touched main's own later commits) was
 * presented as having REVERTED everything main gained since the branch
 * point, inviting phantom P0/P1 findings on code the branch never touched.
 *
 * This runs the REAL script against a real git fixture shaped exactly like
 * the reported scenario: a feature branch cut before a later, unrelated
 * trunk commit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../scripts/scoped-audit.sh');

/**
 * A clean environment for spawning git in a SCRATCH repo. The pre-push hook
 * (and some CI shells) run child processes with GIT_DIR/GIT_WORK_TREE/
 * GIT_INDEX_FILE already pointed at the OUTER repo — inherited by
 * execFileSync/spawnSync by default — which makes git operate on the wrong
 * repository ("fatal: this operation must be run in a work tree") instead of
 * the `cwd` scratch dir these fixtures create.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() }).trim();
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * trunk: base -> "trunk advances" (h.txt)
 * feature: base -> "feature work" (g.txt), cut BEFORE trunk's later commit
 *
 * feature never touched h.txt. A correct three-dot diff (trunk...feature)
 * reports ONLY g.txt; the reported bug reports h.txt too, as if feature had
 * deleted it.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'scoped-audit-3dot-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'trunk');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'f.txt'), 'base');
  git(dir, 'add', 'f.txt');
  git(dir, 'commit', '-qm', 'base');

  git(dir, 'checkout', '-qb', 'feature');
  writeFileSync(join(dir, 'g.txt'), 'feature-change');
  git(dir, 'add', 'g.txt');
  git(dir, 'commit', '-qm', 'feature work');
  const featureSha = git(dir, 'rev-parse', 'HEAD');

  git(dir, 'checkout', '-q', 'trunk');
  writeFileSync(join(dir, 'h.txt'), 'trunk-advance');
  git(dir, 'add', 'h.txt');
  git(dir, 'commit', '-qm', 'trunk advances');
  const trunkSha = git(dir, 'rev-parse', 'HEAD');

  return { dir, trunkSha, featureSha };
}

function runScopedAudit(repoDir: string, prRef: string) {
  const auditInput = join(repoDir, 'out.md');
  // scoped-audit.sh runs `git -C "$REPO_ROOT" diff ...` against repoDir —
  // needs the same clean-env treatment as the git() helper above.
  const r = spawnSync('bash', [SCRIPT, 'test-repo', prRef, repoDir], {
    encoding: 'utf8',
    env: { ...cleanGitEnv(), AUDIT_INPUT: auditInput },
  });
  let output = '';
  try {
    output = readFileSync(auditInput, 'utf8');
  } catch {
    /* not written on early exit — fine for the "no changed files" case */
  }
  return { ...r, output };
}

describe('scoped-audit.sh three-dot diff (#1763)', () => {
  it('a three-dot range reports ONLY the branch-side change, not the ancestor-side commit', () => {
    const { dir, trunkSha, featureSha } = fixture();
    const { stdout, output } = runScopedAudit(dir, `${trunkSha}...${featureSha}`);

    expect(stdout).toContain('g.txt');
    expect(stdout, 'trunk-only h.txt leaked into the changed-file list').not.toContain('h.txt');
    expect(stdout).toMatch(/1 changed source file/);

    expect(output).toContain('g.txt');
    expect(
      output,
      "the diff content must not present feature as having reverted trunk's own commit"
    ).not.toContain('h.txt');
  });

  it('a two-dot range legitimately still behaves as a direct two-commit diff', () => {
    // Two-dot is a real, intentional git operation (not merge-base-relative) —
    // this fix must not accidentally force three-dot semantics onto it.
    const { dir, trunkSha, featureSha } = fixture();
    const { stdout } = runScopedAudit(dir, `${trunkSha}..${featureSha}`);
    expect(stdout).toContain('g.txt');
    expect(stdout).toContain('h.txt');
    expect(stdout).toMatch(/2 changed source file/);
  });

  it('a single bare ref (no range) still diffs against the working tree', () => {
    const { dir, trunkSha } = fixture();
    writeFileSync(join(dir, 'f.txt'), 'working-tree-edit');
    const { stdout } = runScopedAudit(dir, trunkSha);
    expect(stdout).toMatch(/changed source file/);
  });
});

/**
 * Issues 2338 / 2352: the script itself kept three-dot semantics after #1763,
 * but the WORKFLOW handed it `base..head`, and blast-radius.sh still split the
 * range on `..` — so a PR behind main was audited against a two-dot diff that
 * presented main's newer commits as the PR's own deletions.
 */
describe('audit inputs use the merge-base (three-dot) range (issues 2338, 2352)', () => {
  const root = join(__dirname, '../..');

  it('blast-radius.yml passes a three-dot range', () => {
    const yml = readFileSync(join(root, '.github/workflows/blast-radius.yml'), 'utf8');
    expect(yml).toMatch(/blast-radius\.sh ebda "\$\{BASE_SHA:-HEAD~1\}\.\.\.\$\{HEAD_SHA:-HEAD\}"/);
  });

  it('blast-radius.sh keeps three-dot semantics (reports only the branch-side file)', () => {
    const { dir, trunkSha, featureSha } = fixture();
    // The script exits early without a graph; an empty one is enough to reach
    // the changed-file listing. DRY_RUN keeps it off Telegram.
    const graph = join(dir, 'graph.json');
    writeFileSync(graph, JSON.stringify({ nodes: [], links: [] }));
    const r = spawnSync(
      'bash',
      [join(root, 'scripts/blast-radius.sh'), 'test-repo', `${trunkSha}...${featureSha}`, dir],
      { encoding: 'utf8', env: { ...cleanGitEnv(), GRAPH_ROOT: graph, DRY_RUN: '1' } }
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toContain('g.txt');
    expect(out, 'trunk-only h.txt leaked into the blast-radius changed-file list').not.toContain(
      'h.txt'
    );
  });
});
