#!/usr/bin/env node
// Identity stage 5 merge guard (CI). The stage-5 PR removes the Store's last HS256 acceptance for the admin namespace. It must
// not merge until (1) scripts/ops/identity-soak-gate.mjs passed and wrote docs/soak/identity-stage5-report.json (pass=true,
// generated within 48 h) AND (2) Ahmad said go in docs/soak/identity-stage5-approval.json (dated after the report).
// Other PRs pass straight through (`--head-ref` is the PR branch). Pure node, no dependencies.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const STAGE5_BRANCH = 'feat/identity-stage5';

/** report/approval: parsed JSON or undefined when the file is missing. Returns a list of reasons the merge is refused. */
export function stage5Problems({ report, approval, now = Date.now() }) {
  const p = [];
  if (!report)
    p.push(
      'docs/soak/identity-stage5-report.json is missing: run scripts/ops/identity-soak-gate.mjs'
    );
  else {
    if (report.pass !== true) p.push('the soak report does not pass');
    if (
      !Array.isArray(report.criteria) ||
      report.criteria.length !== 4 ||
      report.criteria.some(c => c.pass !== true)
    )
      p.push('the soak report does not show all four criteria passing');
    if (!(now - Date.parse(report.generatedAt) < 48 * 3600_000))
      p.push('the soak report is older than 48 hours: re-run the gate');
  }
  if (!approval) p.push("Ahmad's go is missing: docs/soak/identity-stage5-approval.json");
  else {
    if (approval.approvedBy !== 'Ahmad Sharaf') p.push('the approval is not from Ahmad Sharaf');
    if (report && !(Date.parse(approval.approvedAt) > Date.parse(report.generatedAt)))
      p.push('the approval predates the soak report');
  }
  return p;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const headRef = process.argv.includes('--head-ref')
    ? process.argv[process.argv.indexOf('--head-ref') + 1]
    : '';
  if (headRef !== STAGE5_BRANCH) {
    console.log(
      `stage5-guard: ${headRef || 'this ref'} is not the stage-5 branch, nothing to enforce`
    );
    process.exit(0);
  }
  const read = f =>
    existsSync(join('docs/soak', f))
      ? JSON.parse(readFileSync(join('docs/soak', f), 'utf8'))
      : undefined;
  const problems = stage5Problems({
    report: read('identity-stage5-report.json'),
    approval: read('identity-stage5-approval.json'),
  });
  for (const x of problems) console.error(`stage5-guard: REFUSED - ${x}`);
  if (problems.length) process.exit(1);
  console.log('stage5-guard: soak gate passed and Ahmad approved');
}
