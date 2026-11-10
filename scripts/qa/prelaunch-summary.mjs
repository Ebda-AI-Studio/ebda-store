#!/usr/bin/env node
// Folds a Playwright JSON report into one small result for the alert path:
// { ok, store, passed, failed, skipped, failures: [{ title, project, error }] }. Exit 1 when anything failed
// or when nothing ran (an empty run is not a pass).
// Usage: node scripts/qa/prelaunch-summary.mjs <playwright-results.json> [out.json]
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, out = 'prod-smoke-result.json'] = process.argv;
const report = JSON.parse(readFileSync(input, 'utf8'));
const result = {
  ok: false,
  store: process.env.PRELAUNCH_STORE_SLUG ?? null,
  at: new Date().toISOString(),
  passed: 0,
  failed: 0,
  skipped: 0,
  failures: [],
};
const walk = suite => {
  for (const s of suite.suites ?? []) walk(s);
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const last = t.results?.[t.results.length - 1];
      const status = last?.status ?? 'skipped';
      if (status === 'passed') result.passed++;
      else if (status === 'skipped') result.skipped++;
      else {
        result.failed++;
        result.failures.push({
          title: spec.title,
          project: t.projectName,
          error: String(last?.error?.message ?? status)
            .replace(/\u001b\[[0-9;]*m/g, '')
            .slice(0, 300),
        });
      }
    }
  }
};
for (const s of report.suites ?? []) walk(s);
result.ok = result.failed === 0 && result.passed > 0;
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    ok: result.ok,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
  })
);
process.exit(result.ok ? 0 : 1);
