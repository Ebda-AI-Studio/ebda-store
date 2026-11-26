#!/usr/bin/env node
/**
 * MQ-SCOPE-1: decide whether a merge group needs the HEAVY half of the full lane.
 *
 * Every merge_group run used to execute the whole full tier (~45 min) even for a one-file marketing PR, so a loaded queue hit the 120 min
 * check_response_timeout and dropped a passing PR. This reuses scripts/ci-affected.mjs (`classify` + `integrationPlan`) on
 * merge_group.base_sha..head_sha and answers `heavy=false` ONLY when every changed file is docs or lives in a LIGHT workspace (static or
 * standalone sites that no integration / E2E / builder-E2E / workerd-integration job exercises). Everything else is `heavy=true`.
 * FAIL CLOSED: an unreadable diff, an unknown event, a rail file or the `ci:full` label = heavy. Unit shards, Security Audit,
 * the marketing dry-run, `Repo guards` and `API Worker boots on workerd` always run.
 *
 * Output: `heavy=true|false` to $GITHUB_OUTPUT and a reason on stdout. The merge queue gate accepts `skipped` for HEAVY_ONLY_JOBS iff heavy=false.
 */
import { appendFileSync } from 'node:fs';
import { classify, integrationPlan, loadWorkspaces } from '../ci-affected.mjs';

/** Workspaces whose change cannot move any heavy-only job (verified: test:e2e, builder-e2e and integration never open these). */
export const LIGHT_WORKSPACES = ['apps/marketing', 'apps/docs', 'apps/help', 'apps/status'];

/** Jobs a light merge group may skip (and the gate may accept as `skipped`). */
export const HEAVY_ONLY_JOBS = [
  'build',
  'orphan-tests',
  'test-integration',
  'test-e2e',
  'builder-e2e',
  'workerd-integration',
];

/** The workerd dry-run is skipped, and accepted as `skipped` by the gate, ONLY for a strictly docs-only merge group (CRITICAL-PATH-1). */
export const DOCS_ONLY_SKIPPABLE_JOBS = ['worker-dry-run'];

/**
 * `marketing` (CI-CAPACITY-1): does the marketing Worker dry-run (the only per-app job a merge group runs) need to run? STRICT:
 * true on a label, an empty or unreadable diff, any rail (workflow, script, test, lockfile, shared / repo / database package,
 * migration), classify's `all` (root config, packages/shared, packages/database), or when apps/marketing (or a workspace it
 * depends on) is affected; false only when every changed file is positively outside all of those. Independent of `heavy`.
 */

/** Rails: always the full tier. Beyond classify()'s own `all` (root files, packages/shared, packages/database). */
const RAILS =
  /^(package(-lock)?\.json$|packages\/(shared|repo|database)\/|\.github\/|scripts\/|tests\/|.*\bmigrations?\/|.*\.sql$|.*prisma\/)/;

const DOCS_ONLY = /^(docs\/|.*\.md$|\.github\/ISSUE_TEMPLATE\/|\.vscode\/|\.editorconfig$)/;

/**
 * STRICT docs-only (CRITICAL-PATH-1): every changed file is under docs/ or is a Markdown file, and none is on a rail (a workflow,
 * script, test, migration, lockfile, shared package ...). One other file, or an empty diff, is NOT docs-only. Narrower than DOCS_ONLY
 * above on purpose: no .vscode, no .editorconfig, no issue templates.
 */
const DOCS_STRICT = /^(docs\/.*|(.*\/)?[^/]*\.md)$/;
export function isDocsOnly(files) {
  const changed = (files ?? []).filter(Boolean);
  return changed.length > 0 && changed.every(f => DOCS_STRICT.test(f) && !RAILS.test(f));
}

/**
 * `builder` (CI-SCOPE-2): do the two Builder E2E shards need to run? They drive the admin builder and the storefront in a browser, so
 * the answer is an ALLOW-LIST of what cannot move them, never a list of what can: false only when EVERY changed file is under
 * apps/api, apps/marketing, apps/docs, apps/help or apps/status (or is a docs file), is not a rail (workflow, script, test, lockfile,
 * any packages/, root config, migration, SQL), and is not an API file named for the builder / look / layout / theme / template /
 * storefront / i18n path. The `ci:full` label and an empty diff are true. Independent of `heavy` and `marketing`.
 */
const BUILDER_FREE = /^(apps\/(api|marketing|docs|help|status)\/|docs\/|.*\.md$)/;
const BUILDER_NAMED_API =
  /^apps\/api\/.*(builder|look|layout|theme|template|storefront|i18n|locale)/i;
const BUILDER_RAILS = /^(packages\/|.*\bmigrations?\/|.*\.sql$|.*prisma\/)/;
export function builderNeeded({ files, labels = [] }) {
  const changed = (files ?? []).filter(Boolean);
  if (labels.includes('ci:full') || changed.length === 0) return true;
  return changed.some(
    f =>
      !BUILDER_FREE.test(f) || RAILS.test(f) || BUILDER_RAILS.test(f) || BUILDER_NAMED_API.test(f)
  );
}

/**
 * @param {{ files: string[], labels?: string[], workspaces?: any[] }} a
 * @returns {{ heavy: boolean, reason: string, docsOnly: boolean, marketing: boolean }}
 */
function decideScopeBase({ files, labels = [], workspaces = loadWorkspaces() }) {
  const changed = (files ?? []).filter(Boolean);
  if (labels.includes('ci:full'))
    return { heavy: true, reason: 'ci:full label', docsOnly: false, marketing: true };
  if (changed.length === 0)
    return {
      heavy: true,
      reason: 'empty diff: refusing to guess, full tier',
      docsOnly: false,
      marketing: true,
    };
  const docsOnly = isDocsOnly(changed);
  const code = changed.filter(f => !DOCS_ONLY.test(f) || RAILS.test(f));
  const rail = code.find(f => RAILS.test(f) && !DOCS_ONLY.test(f));
  if (rail) return { heavy: true, reason: `rail file ${rail}`, docsOnly: false, marketing: true };
  const r = classify(changed, workspaces);
  if (r.all)
    return {
      heavy: true,
      reason: 'classify: every workspace affected',
      docsOnly: false,
      marketing: true,
    };
  const marketing = r.workspaces.includes('apps/marketing');
  if (integrationPlan(changed).integration)
    return { heavy: true, reason: 'integration tests affected', docsOnly: false, marketing };
  const heavyWs = r.workspaces.filter(w => !LIGHT_WORKSPACES.includes(w));
  if (heavyWs.length)
    return {
      heavy: true,
      reason: `non-light workspace affected: ${heavyWs.join(' ')}`,
      docsOnly: false,
      marketing,
    };
  return {
    heavy: false,
    docsOnly,
    marketing,
    reason: `only light workspaces / docs changed (${r.workspaces.join(' ') || 'docs'}): heavy-only jobs skipped`,
  };
}

/** @returns {{ heavy: boolean, reason: string, docsOnly: boolean, marketing: boolean, builder: boolean }} */
export function decideScope(a) {
  return { ...decideScopeBase(a), builder: builderNeeded(a) };
}

async function labelsOf(ref, repo, token) {
  const m = /^(?:refs\/heads\/)?gh-readonly-queue\/[^/]+\/pr-(\d+)-/.exec(ref ?? '');
  if (!m) throw new Error(`cannot read the PR number from ${ref}`);
  const r = await fetch(`https://api.github.com/repos/${repo}/issues/${m[1]}/labels`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`labels answered ${r.status}`);
  return (await r.json()).map(l => l.name);
}

/** Changed files via the compare API (no shallow `git fetch`: tests/unit/migration-order-gate.test.ts bans it). >=300 files = truncated = heavy. */
async function changedFiles(base, head, repo, token) {
  const r = await fetch(
    `https://api.github.com/repos/${repo}/compare/${base}...${head}?per_page=100`,
    {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    }
  );
  if (!r.ok) throw new Error(`compare answered ${r.status}`);
  const j = await r.json();
  if ((j.files ?? []).length >= 100 || j.total_commits > 250)
    throw new Error('compare list may be truncated');
  return j.files.flatMap(f => [f.filename, f.previous_filename]).filter(Boolean);
}

async function main() {
  const { EVENT, BASE_SHA, HEAD_SHA, HEAD_REF, GITHUB_REPOSITORY, GITHUB_TOKEN } = process.env;
  let out;
  try {
    if (EVENT !== 'merge_group')
      out = {
        heavy: true,
        reason: `event ${EVENT}: full lane rules apply`,
        docsOnly: false,
        marketing: true,
        builder: true,
      };
    else {
      if (!BASE_SHA || !HEAD_SHA) throw new Error('missing merge group shas');
      const files = await changedFiles(BASE_SHA, HEAD_SHA, GITHUB_REPOSITORY, GITHUB_TOKEN);
      const labels = await labelsOf(HEAD_REF, GITHUB_REPOSITORY, GITHUB_TOKEN);
      out = decideScope({ files, labels });
    }
  } catch (e) {
    out = {
      heavy: true,
      reason: `fail closed: ${e.message}`,
      docsOnly: false,
      marketing: true,
      builder: true,
    };
  }
  console.log(
    `mq-scope: heavy=${out.heavy} docs_only=${out.docsOnly} marketing=${out.marketing} builder=${out.builder} (${out.reason})`
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `heavy=${out.heavy}\ndocs_only=${out.docsOnly}\nmarketing=${out.marketing}\nbuilder=${out.builder}\n`
    );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
