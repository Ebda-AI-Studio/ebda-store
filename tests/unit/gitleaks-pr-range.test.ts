import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cleanGitEnv, initSandboxRepo } from '../helpers/git-env';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// #228 (2026-10-25): one branch's test fixture failed gitleaks on EVERY other PR, because `gitleaks detect` walks
// `git log --all` and CI checks out with fetch-depth 0. A PR must be scanned over its own commits only.
const ROOT = join(__dirname, '../../');
const wf = readFileSync(join(ROOT, '.github/workflows/gitleaks.yml'), 'utf8');
const hasGitleaks = spawnSync('gitleaks', ['version']).status === 0;

describe('gitleaks workflow scope', () => {
  it('GITLEAKS-SCOPE-1: PR = base..head, push to main = before..after, nightly/dispatch = HEAD; never --all', () => {
    expect(wf).toContain('RANGE="${BASE_SHA}..${HEAD_SHA}"');
    expect(wf).toMatch(/if \[ "\$EVENT_NAME" = "pull_request" \]/);
    expect(wf).toContain('RANGE="${PUSH_BEFORE}..${PUSH_AFTER}"');
    expect(wf).toMatch(/else\s*\n\s*RANGE="HEAD"/);
    // the one scan command always carries an explicit range, so it can never fall back to `git log --all`
    expect(wf).toContain('--log-opts="${RANGE}"');
    expect(wf).not.toMatch(/gitleaks detect --source \. --config \.gitleaks\.toml --redact/);
    expect(wf).toMatch(/schedule:\s*\n\s*#[^\n]*\n\s*- cron:/);
    expect(wf).toMatch(/push:\s*\n\s*branches: \[main\]/);
  });
  it('the SHAs reach the step through env, never interpolated into the script', () => {
    const run = wf.slice(wf.indexOf('- name: Run gitleaks'), wf.indexOf('notify-failure:'));
    expect(run).toContain('BASE_SHA: ${{ github.event.pull_request.base.sha }}');
    expect(run.slice(run.indexOf('run: |'))).not.toContain('${{');
  });
  it('the repo config used by CI is the one the local hook uses (.gitleaks.toml)', () => {
    expect(wf).toContain('--config .gitleaks.toml');
  });
});

// Needs the gitleaks binary (installed on the Mac; the CI image installs it inside the workflow itself).
describe.skipIf(!hasGitleaks)('gitleaks range semantics (real binary)', () => {
  // all git goes through the sandbox helper: it strips the hook's GIT_* env and ignores global config
  const scan = (cwd: string, logOpts?: string) =>
    spawnSync(
      'gitleaks',
      [
        'detect',
        '--source',
        '.',
        '--config',
        join(ROOT, '.gitleaks.toml'),
        '--no-banner',
        '--exit-code',
        '1',
        ...(logOpts ? [`--log-opts=${logOpts}`] : []),
      ],
      { cwd, encoding: 'utf8', env: cleanGitEnv() }
    ).status;

  it("another branch's secret fails an --all scan but NOT this PR's range", () => {
    const { dir: d, git: g } = initSandboxRepo('gl-');
    writeFileSync(join(d, 'a.txt'), 'hello\n');
    g('add', '.');
    g('commit', '-qm', 'base');
    const base = g('rev-parse', 'HEAD');
    // some OTHER open PR's branch carries a fixture that looks like a token
    g('checkout', '-qb', 'other-pr');
    writeFileSync(join(d, 'fixture.ts'), 'const key = "AKIA' + 'QYLPMN5HHKJ2XYZ7' + '";\n');
    g('add', '.');
    g('commit', '-qm', 'fixture');
    // this PR
    g('checkout', '-q', 'main');
    g('checkout', '-qb', 'my-pr');
    writeFileSync(join(d, 'b.txt'), 'clean change\n');
    g('add', '.');
    g('commit', '-qm', 'mine');
    const head = g('rev-parse', 'HEAD');
    expect(scan(d)).toBe(1); // the old behaviour: full history sees other-pr's secret
    expect(scan(d, `${base}..${head}`)).toBe(0); // the new PR scan does not
    // and the range scan still catches a secret IN this PR
    writeFileSync(join(d, 'c.ts'), 'const k2 = "AKIA' + 'ZXCVBN4MASDF5GHJ' + '";\n');
    g('add', '.');
    g('commit', '-qm', 'oops');
    expect(scan(d, `${base}..${g('rev-parse', 'HEAD')}`)).toBe(1);
  }, 120_000); // the binary scans a real git history; slow under a loaded host
});
