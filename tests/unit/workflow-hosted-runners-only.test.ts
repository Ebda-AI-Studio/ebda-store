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
  // Ruling CI-ROUTE-1: a pull_request labelled `ci-umbra` routes its WHOLE run to Umbra; every other event is unchanged.
  const ROUTE = `contains(github.event.pull_request.labels.*.name, 'ci-umbra') && '["self-hosted","umbra-ebda"]'`;
  const ROUTED = `\${{ fromJSON(${ROUTE} || vars.EBDA_RUNS_ON || '"ubuntu-24.04"') }}`;
  // Push-to-main deploy workflows (cf-*-deploy.yml) keep the plain selector: no PR label can reach them.
  const PLAIN = `\${{ fromJSON(vars.EBDA_RUNS_ON || '"ubuntu-24.04"') }}`;
  it('every runs-on is the EBDA_RUNS_ON switch with an ubuntu-24.04 fallback', () => {
    // The literal-runner exception db-backup.yml had (Ruling OFFMACHINE-1) went with that workflow (Ruling NZ-17-BACKUP-1).
    const bad = runsOnValues().filter(r => r.value !== ROUTED && r.value !== PLAIN);
    expect(
      bad.map(r => `${r.file}:${r.line} -> ${r.value}`),
      'runs-on must be exactly the EBDA_RUNS_ON switch (fallback ubuntu-24.04)'
    ).toEqual([]);
  });
});

const CI_ROUTE = `contains(github.event.pull_request.labels.*.name, 'ci-umbra') && '["self-hosted","umbra-ebda"]'`;

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
    // Ruling CI-ROUTE-1: the one whole-PR label route (exact string) is the only allowed self-hosted/umbra mention in code.
    code = code.split(CI_ROUTE).join('').split("'ci-umbra'").join('');
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
