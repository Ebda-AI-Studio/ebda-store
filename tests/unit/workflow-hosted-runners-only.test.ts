/**
 * Ebda's CI runs on GitHub-hosted runners only (SP4 task 9, Ahmad's decision):
 * "it needs no Umbra". Umbra is Ebda's self-hosted runner fleet; nothing in
 * Ebda may depend on it, because Ebda's workflows must keep working when no
 * such runner exists (GitHub QUEUES a job whose labels match no online runner
 * for up to ~24h instead of failing it, so a leftover label silently hangs
 * the workflow).
 *
 * This replaces the Ebda-era runner-selector test, which pinned the
 * `vars.USE_SELF_HOSTED` / `vars.SCHEDULED_ON_CLOUD` switch forms. Those
 * switches are gone: every `runs-on` is the literal `ubuntu-latest`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const GITHUB_DIR = path.join(ROOT, '.github');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const WORKFLOWS = path.join(GITHUB_DIR, 'workflows');
const workflowFiles = fs.readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f));

/** Every `runs-on:` value, with its file and line (comments excluded). */
function runsOnValues(): Array<{ file: string; line: number; value: string }> {
  return workflowFiles.flatMap(file =>
    fs
      .readFileSync(path.join(WORKFLOWS, file), 'utf8')
      .split('\n')
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => /^\s{2,}runs-on:\s*\S/.test(text))
      .map(({ text, line }) => ({
        file,
        line,
        value: text.replace(/^\s*runs-on:\s*/, '').trim(),
      }))
  );
}

describe('every workflow job runs on a GitHub-hosted runner', () => {
  it('actually reads the workflows (the walk is not silently empty)', () => {
    expect(workflowFiles).toEqual(
      expect.arrayContaining(['ci.yml', 'gitleaks.yml', 'semgrep.yml', 'blast-radius.yml'])
    );
    expect(runsOnValues().length).toBeGreaterThan(10);
  });

  // Ruling CI-UMBRA-1 (Ahmad 2026-10-07): Ebda MAY run on the Umbra org runner
  // when the repo variable EBDA_RUNS_ON is set; with the variable unset every job
  // falls back to GitHub-hosted `ubuntu-24.04`. This is the ONLY allowed form,
  // so deleting the variable is the single switch back to hosted runners.
  // Ruling CI-SPLIT-1 adds a second switch for LIGHT jobs: EBDA_RUNS_ON_LIGHT, then EBDA_RUNS_ON, then hosted. Unset =
  // identical to the heavy switch, so the same one-variable fallback holds.
  const ALLOWED = `\${{ fromJSON(vars.EBDA_RUNS_ON || '"ubuntu-24.04"') }}`;
  const ALLOWED_LIGHT = `\${{ fromJSON(vars.EBDA_RUNS_ON_LIGHT || vars.EBDA_RUNS_ON || '"ubuntu-24.04"') }}`;
  it('every runs-on is the EBDA_RUNS_ON switch (or the LIGHT switch) with an ubuntu-24.04 fallback', () => {
    // Ruling OFFMACHINE-1: the off-machine database backup must NOT depend on the Umbra fleet (the Mac and the CI guest are
    // exactly what it protects against), so db-backup.yml alone pins the literal GitHub-hosted runner.
    const bad = runsOnValues().filter(
      r =>
        r.value !== ALLOWED &&
        r.value !== ALLOWED_LIGHT &&
        !(r.file === 'db-backup.yml' && r.value === 'ubuntu-24.04')
    );
    expect(
      bad.map(r => `${r.file}:${r.line} -> ${r.value}`),
      'runs-on must be exactly the EBDA_RUNS_ON switch (fallback ubuntu-24.04)'
    ).toEqual([]);
  });
});

// Ruling CI-SPLIT-1: the LIGHT switch is for cheap jobs only (hosted minutes cost money), each with a hard timeout.
describe('the LIGHT runner switch is confined to light jobs', () => {
  const LIGHT_CI_JOBS = ['changes', 'guards', 'lint', 'typecheck', 'notify-failure'];
  const jobBlocks = (file: string) =>
    fs
      .readFileSync(path.join(WORKFLOWS, file), 'utf8')
      .split('\njobs:\n')[1]
      .split(/^(?=  [A-Za-z0-9_-]+:\s*$)/m)
      .filter(b => /^  [A-Za-z0-9_-]+:/.test(b))
      .map(b => ({ name: /^  ([A-Za-z0-9_-]+):/.exec(b)![1], body: b }));

  it('in ci.yml exactly the light jobs use it, with timeout <= 10', () => {
    const onLight = jobBlocks('ci.yml').filter(j => j.body.includes('vars.EBDA_RUNS_ON_LIGHT'));
    expect(onLight.map(j => j.name).sort()).toEqual([...LIGHT_CI_JOBS].sort());
    for (const j of onLight) {
      const t = Number(/^ {4}timeout-minutes: (\d+)/m.exec(j.body)?.[1]);
      expect(t, `${j.name} timeout`).toBeLessThanOrEqual(10);
    }
  });

  it.each(workflowFiles.filter(f => /^cf-.*-deploy\.yml$/.test(f)))(
    '%s: every job uses it, light <= 10 min and deploy <= 20 min',
    f => {
      for (const j of jobBlocks(f)) {
        expect(j.body, `${f}:${j.name}`).toContain('vars.EBDA_RUNS_ON_LIGHT');
        const t = Number(/^ {4}timeout-minutes: (\d+)/m.exec(j.body)?.[1]);
        expect(t, `${f}:${j.name} timeout`).toBeLessThanOrEqual(j.name === 'deploy' ? 20 : 10);
      }
    }
  );
});

describe('nothing under .github mentions a self-hosted runner or its switches', () => {
  // Comments are prose and may explain WHY a switch is gone; only code counts.
  const FORBIDDEN = [
    /self-hosted/i,
    /USE_SELF_HOSTED/,
    /SCHEDULED_ON_CLOUD/,
    /force_cloud/,
    /\bumbra\b/i,
    /\bwsl2?\b/i,
    new RegExp('fw' + 'b-ci', 'i'),
  ];

  const files = walk(GITHUB_DIR).filter(f => /\.(ya?ml|mjs|js|sh|md|json)$/.test(f));

  it('scans a non-empty file set', () => {
    expect(files.length).toBeGreaterThan(4);
  });

  // Ruling CI-NODE-MODULES-1 (Umbra-only CI, Ahmad 2026-11-03): the npm-ci composite action may branch on
  // `runner.environment == 'self-hosted'` to reuse node_modules on the runner. That exact expression in that one
  // file is the only exemption; a runs-on label, the old switches or any other self-hosted mention still fails.
  const EXEMPT: Record<string, RegExp> = {
    '.github/actions/npm-ci/action.yml': /runner\.environment\s*==\s*'self-hosted'/g,
  };

  it.each(files.map(f => [path.relative(ROOT, f), f] as const))('%s', (_rel, file) => {
    let code = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n');
    const exempt = EXEMPT[_rel.split(path.sep).join('/')];
    if (exempt) code = code.replace(exempt, '');
    for (const re of FORBIDDEN) {
      expect(code, `${_rel} matches ${re}`).not.toMatch(re);
    }
  });

  it('the vars/runner switches are absent from every workflow, comments included', () => {
    for (const f of workflowFiles) {
      const raw = fs.readFileSync(path.join(WORKFLOWS, f), 'utf8');
      expect(raw, f).not.toMatch(
        /vars\.USE_SELF_HOSTED|vars\.SCHEDULED_ON_CLOUD|inputs\.force_cloud/
      );
    }
  });
});
