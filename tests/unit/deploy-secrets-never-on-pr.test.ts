/**
 * Ruling DEPLOY-PARITY-1 + the WA session's WA-DEPLOY-1: Whisky-11 is Free/private with no environment protection, so a deploy
 * secret must be unreachable from anything a pull request can trigger. (1) No PR-triggered workflow references a deploy secret.
 * (2) Deploy workflows run only on push to main or dispatch. (3) A PR that changes deploy files needs the `deploy-change` label.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs without types
import { check, deployFilesChanged } from '../../scripts/ci/deploy-change-label.mjs';

const ROOT = path.resolve(__dirname, '../..');
const WF = path.join(ROOT, '.github/workflows');
const files = readdirSync(WF).filter(f => /\.ya?ml$/.test(f));
const text = (f: string) => readFileSync(path.join(WF, f), 'utf8');

/** Top-level `on:` trigger names of a workflow. */
function triggers(raw: string): string[] {
  const lines = raw.split('\n');
  const i = lines.findIndex(l => /^on:\s*$/.test(l));
  if (i < 0) return (/^on:\s*\[?([^\n\]]+)/m.exec(raw)?.[1] ?? '').split(/[,\s]+/).filter(Boolean);
  const out: string[] = [];
  for (let j = i + 1; j < lines.length && /^(\s|$)/.test(lines[j]); j++) {
    const m = /^ {2}([a-z_]+):/.exec(lines[j]);
    if (m) out.push(m[1]);
  }
  return out;
}

const DEPLOY_SECRET =
  /secrets\.(CLOUDFLARE_[A-Z_]+|EBDA_MIGRATE_DATABASE_URL|SENTRY_AUTH_TOKEN)|secrets:\s*inherit|toJSON\(secrets\)/;
const PR_TRIGGERS = ['pull_request', 'pull_request_target', 'workflow_run'];

describe('deploy secrets are unreachable from a pull request', () => {
  it('reads the workflows', () => expect(files.length).toBeGreaterThan(10));
  it.each(files)('%s: a PR-triggered workflow never references a deploy secret', f => {
    const raw = text(f);
    if (!triggers(raw).some(t => PR_TRIGGERS.includes(t))) return;
    const code = raw
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n');
    expect(
      DEPLOY_SECRET.test(code),
      `${f} is triggered by a PR but references a deploy secret`
    ).toBe(false);
  });
  const deploys = files.filter(f => /^cf-.*-deploy\.yml$/.test(f));
  it.each(deploys)('%s runs only on push to main or manual dispatch', f => {
    const raw = text(f);
    expect(triggers(raw).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(raw).toMatch(/push:\s*\n\s+branches:\s*\[main\]|push:\s*\n\s+branches:\s*\n\s+- main/);
  });
  it('db-backup.yml (holds the dump URL) is schedule or dispatch only', () => {
    expect(triggers(text('db-backup.yml')).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });
});

describe('deploy-change label check', () => {
  it('flags deploy workflow, guard and secret-list changes', () => {
    expect(
      deployFilesChanged([
        '.github/workflows/cf-web-deploy.yml',
        'apps/web/x.ts',
        'scripts/ci/api-required-secrets.json',
      ])
    ).toEqual(['.github/workflows/cf-web-deploy.yml', 'scripts/ci/api-required-secrets.json']);
  });
  it('fails without the label, passes with it, and ignores unrelated PRs', () => {
    expect(check(['.github/workflows/cf-api-deploy.yml'], []).ok).toBe(false);
    expect(check(['.github/workflows/cf-api-deploy.yml'], ['bug']).ok).toBe(false);
    expect(check(['.github/workflows/cf-api-deploy.yml'], ['deploy-change']).ok).toBe(true);
    expect(check(['apps/web/src/x.ts', 'docs/a.md'], []).ok).toBe(true);
  });
  it('the check has a workflow, and it needs no secrets', () => {
    const raw = text('deploy-change-label.yml');
    expect(triggers(raw)).toEqual(['pull_request']);
    expect(raw).toMatch(/types: \[opened, synchronize, reopened, labeled, unlabeled\]/);
    expect(
      /secrets\./.test(
        raw
          .split('\n')
          .filter(l => !/^\s*#/.test(l))
          .join('\n')
      )
    ).toBe(false);
  });
});
