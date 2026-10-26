#!/usr/bin/env node
/**
 * deploy-change-label.mjs - a PR that changes how production is deployed needs the `deploy-change` label (Ruling
 * DEPLOY-PARITY-1: Whisky-11 is a Free-plan private org, so there is no environment protection or CODEOWNERS enforcement; this
 * check is the human checkpoint). Usage: node scripts/ci/deploy-change-label.mjs --base <sha> --labels '<json array>'
 * Exit 0 ok / not applicable, 1 = deploy files changed and the label is missing.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'deploy-change';
/** Files that decide what reaches production: the deploy workflows, the backup workflow, the deploy guard and its secret list. */
export const DEPLOY_FILE =
  /^(\.github\/workflows\/(cf-[a-z0-9-]+-deploy|db-backup)\.yml|scripts\/ci\/(deploy-guard\.mjs|api-required-secrets\.json)|scripts\/cf-build\.sh|scripts\/ebda-cf-api-config\.mjs)$/;

export function deployFilesChanged(files) {
  return files.filter(f => DEPLOY_FILE.test(f));
}

export function check(files, labels) {
  const changed = deployFilesChanged(files);
  if (changed.length === 0) return { ok: true, changed };
  return { ok: labels.includes(LABEL), changed };
}

function main(argv) {
  const val = k => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
  const base = val('base');
  const labels = JSON.parse(val('labels') || '[]');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const r = check(files, labels);
  if (!r.ok) {
    console.error(
      `::error::this PR changes production deploy files (${r.changed.join(', ')}) and has no "${LABEL}" label. Add the label after a human has read the diff.`
    );
    return 1;
  }
  console.log(
    r.changed.length
      ? `deploy files changed and labelled "${LABEL}": ${r.changed.join(', ')}`
      : 'no deploy files changed'
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
