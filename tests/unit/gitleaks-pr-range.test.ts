import { describe, expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #228 (2026-10-25): one branch's test fixture failed gitleaks on EVERY other PR, because `gitleaks detect` walks
// `git log --all` and CI checks out with fetch-depth 0. A PR must be scanned over its own commits only.
const ROOT = join(__dirname, '../../');
const wf = readFileSync(join(ROOT, '.github/workflows/gitleaks.yml'), 'utf8');
const hasGitleaks = spawnSync('gitleaks', ['version']).status === 0;

describe('gitleaks workflow scope', () => {
  it('a pull_request scans base..head only; main pushes, nightly and dispatch scan the full history', () => {
    expect(wf).toContain('--log-opts="${BASE_SHA}..${HEAD_SHA}"');
    expect(wf).toMatch(/if \[ "\$EVENT_NAME" = "pull_request" \]/);
    expect(wf).toMatch(
      /else[\s\S]*gitleaks detect --source \. --config \.gitleaks\.toml --redact --verbose --exit-code 1/
    );
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
  // NEVER let this test touch a real repository. Git hooks (husky pre-push, which runs the unit suite) export GIT_DIR,
  // GIT_INDEX_FILE, GIT_WORK_TREE...; inherited here, `git init` + `commit` + `checkout` act on the CHECKOUT THAT IS
  // RUNNING THE HOOK (2026-10-25: it flipped the shared repo to core.bare=true and committed onto the feature branch).
  // So: strip every GIT_* variable, ignore global/system config, and refuse to run unless the repo toplevel is the tmpdir.
  const cleanEnv = () => {
    const e: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) e[k] = v;
    return { ...e, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  };
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
      cwd,
      encoding: 'utf8',
      env: cleanEnv(),
    }).trim();
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
      { cwd, encoding: 'utf8', env: cleanEnv() }
    ).status;

  it("another branch's secret fails an --all scan but NOT this PR's range", () => {
    const d = mkdtempSync(join(tmpdir(), 'gl-'));
    git(d, 'init', '-q', '-b', 'main');
    // belt and braces: the repository git sees from here must be this temp dir, nothing else
    expect(realpathSync(git(d, 'rev-parse', '--show-toplevel'))).toBe(realpathSync(d));
    writeFileSync(join(d, 'a.txt'), 'hello\n');
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'base');
    const base = git(d, 'rev-parse', 'HEAD');
    // some OTHER open PR's branch carries a fixture that looks like a token
    git(d, 'checkout', '-qb', 'other-pr');
    writeFileSync(join(d, 'fixture.ts'), 'const key = "AKIA' + 'QYLPMN5HHKJ2XYZ7' + '";\n');
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'fixture');
    // this PR
    git(d, 'checkout', '-q', 'main');
    git(d, 'checkout', '-qb', 'my-pr');
    writeFileSync(join(d, 'b.txt'), 'clean change\n');
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'mine');
    const head = git(d, 'rev-parse', 'HEAD');
    expect(scan(d)).toBe(1); // the old behaviour: full history sees other-pr's secret
    expect(scan(d, `${base}..${head}`)).toBe(0); // the new PR scan does not
    // and the range scan still catches a secret IN this PR
    writeFileSync(join(d, 'c.ts'), 'const k2 = "AKIA' + 'ZXCVBN4MASDF5GHJ' + '";\n');
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'oops');
    expect(scan(d, `${base}..${git(d, 'rev-parse', 'HEAD')}`)).toBe(1);
  }, 120_000); // the binary scans a real git history; slow under a loaded host
});
