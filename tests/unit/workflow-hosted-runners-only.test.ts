/**
 * NO workflow can run on a GitHub-hosted runner (Ahmad 2026-11-16: never hosted runners on PRIVATE repos, no hosted minutes; since 2026-11-23 the public Ebda repos run hosted by setting their repo variables, the file never names an image). This file used to pin the OPPOSITE
 * policy (SP4 task 9 / CI-UMBRA-1: every `runs-on` falls back to hosted `ubuntu-24.04`); that rule is superseded. Every `runs-on` is a repo variable
 * with a Mac-label fallback: heavy `["self-hosted","ebda-mac"]`, light `["ebda-mac-light"]`. A leftover hosted fallback silently takes over the
 * moment a variable is unset, and GitHub QUEUES a job whose labels match no online runner instead of failing it, so the guard is the test.
 * (The file name is historical; it is the repo's runner-policy guard.)
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

describe('no workflow job can run on a GitHub-hosted runner', () => {
  it('actually reads the workflows (the walk is not silently empty)', () => {
    expect(workflowFiles).toEqual(
      expect.arrayContaining(['ci.yml', 'gitleaks.yml', 'semgrep.yml', 'blast-radius.yml'])
    );
    expect(runsOnValues().length).toBeGreaterThan(10);
  });

  // The two allowed forms. Each falls back to a Mac label, never a hosted image.
  const HEAVY_FALLBACK = `'["self-hosted","ebda-mac"]'`;
  const LIGHT_FALLBACK = `'["ebda-mac-light"]'`;
  // Push-to-main deploy workflows (cf-*-deploy.yml) keep the plain selector: no PR label can reach them.
  const PLAIN = `\${{ fromJSON(vars.EBDA_RUNS_ON || ${HEAVY_FALLBACK}) }}`;
  // Ruling HOST-RUNNERS-2: light jobs prefer EBDA_LIGHT_RUNS_ON, then EBDA_RUNS_ON, then the light Mac label.
  const LIGHT = `\${{ fromJSON(vars.EBDA_LIGHT_RUNS_ON || vars.EBDA_RUNS_ON || ${LIGHT_FALLBACK}) }}`;
  /** GitHub-hosted image names: ubuntu-*, windows-*, macos-* (self-hosted Macs are selected by the ebda-mac labels, never by these). */
  const HOSTED = /\b(ubuntu|windows|macos)-(latest|\d[\w.-]*)\b/i;
  it('the hosted-image detector flags hosted runs-on values and passes Mac ones (it cannot rot into a vacuous pass)', () => {
    expect(HOSTED.test(`\${{ fromJSON(vars.EBDA_RUNS_ON || '"ubuntu-24.04"') }}`)).toBe(true);
    expect(HOSTED.test('ubuntu-latest')).toBe(true);
    expect(HOSTED.test('macos-14')).toBe(true);
    expect(HOSTED.test(PLAIN)).toBe(false);
    expect(HOSTED.test(LIGHT)).toBe(false);
  });
  it('every runs-on is one of the two Mac-fallback forms, and none names a hosted image', () => {
    const values = runsOnValues();
    expect(
      values.filter(r => HOSTED.test(r.value)).map(r => `${r.file}:${r.line} -> ${r.value}`),
      'a hosted runner name in runs-on'
    ).toEqual([]);
    const bad = values.filter(r => r.value !== PLAIN && r.value !== LIGHT);
    expect(
      bad.map(r => `${r.file}:${r.line} -> ${r.value}`),
      'runs-on must be exactly a repo-variable switch with a Mac-label fallback'
    ).toEqual([]);
  });
});

describe('the retired Umbra route is gone (Umbra retired by Ahmad 2026-11-14)', () => {
  it('no workflow mentions the ci-umbra label or the umbra-ebda runner label', () => {
    for (const f of workflowFiles) {
      const raw = fs.readFileSync(path.join(WORKFLOWS, f), 'utf8');
      expect(raw, f).not.toMatch(/ci-umbra|umbra-ebda/);
    }
  });
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
    // Ruling NO-HOSTED-RUNNERS-1: the heavy Mac fallback label set is the other allowed self-hosted mention in code (exact string).
    code = code.split(`'["self-hosted","ebda-mac"]'`).join('');
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

describe('light jobs route to the light runners, heavy jobs never do (Ruling HOST-RUNNERS-2)', () => {
  const LIGHT_EXPR = 'vars.EBDA_LIGHT_RUNS_ON';
  const lightLines = runsOnValues().filter(r => r.value.includes(LIGHT_EXPR));
  it('the light set is exactly the listed cheap jobs', () => {
    const jobAt = (file: string, line: number) => {
      const lines = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8').split('\n').slice(0, line);
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /^  ([a-z0-9_-]+):\s*$/.exec(lines[i]);
        if (m) return `${file}:${m[1]}`;
      }
      return `${file}:?`;
    };
    expect(lightLines.map(r => jobAt(r.file, r.line)).sort()).toEqual(
      [
        'ai-review.yml:classify',
        'ai-review.yml:fork-gate',
        'ai-review.yml:manual-pass',
        'ai-review.yml:review',
        'blast-radius.yml:blast-radius',
        'cf-accounts-deploy.yml:deploy',
        'cf-accounts-deploy.yml:notify-failure',
        'cf-accounts-deploy.yml:plan',
        'cf-admin-deploy.yml:deploy',
        'cf-admin-deploy.yml:notify-failure',
        'cf-admin-deploy.yml:plan',
        'cf-api-deploy.yml:deploy',
        'cf-api-deploy.yml:notify-failure',
        'cf-api-deploy.yml:plan',
        'cf-docs-deploy.yml:deploy',
        'cf-docs-deploy.yml:notify-failure',
        'cf-docs-deploy.yml:plan',
        'cf-help-deploy.yml:deploy',
        'cf-help-deploy.yml:notify-failure',
        'cf-help-deploy.yml:plan',
        'cf-marketing-deploy.yml:deploy',
        'cf-marketing-deploy.yml:notify-failure',
        'cf-marketing-deploy.yml:plan',
        'cf-orders-deploy.yml:deploy',
        'cf-orders-deploy.yml:notify-failure',
        'cf-orders-deploy.yml:plan',
        'cf-status-deploy.yml:deploy',
        'cf-status-deploy.yml:notify-failure',
        'cf-status-deploy.yml:plan',
        'cf-web-deploy.yml:deploy',
        'cf-web-deploy.yml:notify-failure',
        'cf-web-deploy.yml:plan',
        'ci-full-pr.yml:dispatch',
        'ci.yml:app-builds',
        'ci.yml:changes',
        'ci.yml:guards',
        'ci.yml:lint',
        'ci.yml:merge-queue-gate',
        'ci.yml:notify-failure',
        'ci.yml:tested-tree',
        'ci.yml:typecheck',
        'ci.yml:unit-gate',
        'deploy-change-label.yml:deploy-label',
        'gitleaks.yml:notify-failure',
        'gitleaks.yml:scan',
        'pr-quality.yml:pr-body',
        'pr-quality.yml:slop-baselines',
        'pr-quality.yml:capability-ratchet',
      ].sort()
    );
  });
  it('no light job takes the heavy lock or a per-job database', () => {
    const ci = fs.readFileSync(path.join(WORKFLOWS, 'ci.yml'), 'utf8');
    for (const job of ['changes', 'guards', 'unit-gate', 'app-builds']) {
      const start = ci.indexOf(`\n  ${job}:\n`);
      const next = ci.slice(start + 1).search(/\n  [a-z0-9_-]+:\n/);
      const body = ci.slice(start, next < 0 ? undefined : start + 1 + next);
      expect(body, job).not.toMatch(/heavy-lock\.sh|ci-services\.sh/);
    }
  });
});
