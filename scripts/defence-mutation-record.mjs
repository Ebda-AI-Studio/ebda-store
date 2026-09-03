#!/usr/bin/env node
/**
 * Defence mutation record.
 *
 * For every security defence whose test the standard marks "mutation record
 * mandatory" (authn/session, tenant/RLS, money/payment/refund, consent,
 * erasure), this proves the guarding test ACTUALLY FAILS when the defence is
 * removed — the only evidence that separates a real gate from a green test
 * that would pass either way.
 *
 * Why this exists rather than just widening stryker.conf.json's `mutate` list:
 * Stryker here runs `vitest.stryker.config.ts`, whose `include` is
 * `tests/unit/**` only. Every integration-defended control — RLS session GUC,
 * cross-tenant accounting scoping, GDPR erasure, refresh-token rotation —
 * is structurally unreachable by it, so adding those source files to `mutate`
 * would score them 0% for a reason that has nothing to do with test quality
 * and would then be enshrined as a `break` floor. A per-defence record answers
 * the question the aggregate percentage cannot: "if someone deletes THIS line,
 * does CI stop them?"
 *
 * Each spec entry names a source file, an exact string to replace (the defence)
 * and what to replace it with (the defence removed), plus the test that must
 * then fail. The run applies one mutation at a time, executes only the named
 * test, and restores the file — always, including on crash or SIGINT.
 *
 *   node scripts/defence-mutation-record.mjs                 # run + print
 *   node scripts/defence-mutation-record.mjs --write         # + update the record
 *   node scripts/defence-mutation-record.mjs --only=<id,...> # subset
 *   node scripts/defence-mutation-record.mjs --tier=unit     # unit|integration|all
 *
 * Exit code is non-zero if any in-scope defence SURVIVES its mutation (the test
 * still passed with the defence gone) — that is a hole, and CI should stop.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = path.join(ROOT, 'docs/security/defence-mutations.json');
const RECORD_PATH = path.join(ROOT, 'docs/security/defence-mutation-record.md');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const only = args
  .find(a => a.startsWith('--only='))
  ?.slice(7)
  .split(',')
  .filter(Boolean);
const tier = args.find(a => a.startsWith('--tier='))?.slice(7) ?? 'unit';

/** Files we have edited and must put back, even if the process dies. */
const dirty = new Map();

function restoreAll() {
  for (const [file, original] of dirty) writeFileSync(file, original);
  dirty.clear();
}
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restoreAll();
    process.exit(130);
  });
}

/**
 * Apply one mutation, run its test, restore. Returns a verdict.
 *
 * KILLED   — the test failed with the defence removed. The gate is real.
 * SURVIVED — the test still passed. The defence is unguarded. This is the bug.
 * ERROR    — the mutation did not apply (the source moved), or the test could
 *            not run. Treated as a failure: an unappliable spec is a stale
 *            record, which is the exact condition this file exists to prevent.
 */
function runOne(entry) {
  const abs = path.join(ROOT, entry.source);
  let original;
  try {
    original = readFileSync(abs, 'utf8');
  } catch {
    return { verdict: 'ERROR', detail: `source not found: ${entry.source}` };
  }

  const hits = original.split(entry.find).length - 1;
  if (hits !== 1) {
    return {
      verdict: 'ERROR',
      detail: `expected exactly 1 occurrence of the defence in ${entry.source}, found ${hits} — the spec is stale`,
    };
  }

  // Sanity: the test must PASS before we touch anything. A test that is already
  // red (or skipped, or matches no file) would otherwise "fail" under mutation
  // and be scored KILLED for entirely the wrong reason.
  const before = runTest(entry);
  if (!before.passed) {
    return {
      verdict: 'ERROR',
      detail: `baseline test is not green before mutation: ${before.summary}`,
    };
  }

  dirty.set(abs, original);
  writeFileSync(abs, original.replace(entry.find, entry.replace));
  const after = runTest(entry);
  writeFileSync(abs, original);
  dirty.delete(abs);

  return after.passed
    ? { verdict: 'SURVIVED', detail: 'test still passed with the defence removed' }
    : { verdict: 'KILLED', detail: after.summary };
}

function runTest(entry) {
  const config = entry.tier === 'integration' ? 'vitest.config.ts' : 'vitest.stryker.config.ts';
  // The repo-local binary, never `npx vitest` — with no node_modules present
  // npx silently downloads a DIFFERENT vitest into its cache, which then fails
  // to resolve the config's own vite and reports every defence as ERROR.
  const res = spawnSync(
    path.join(ROOT, 'node_modules/.bin/vitest'),
    ['run', '--config', config, '--reporter=dot', entry.test],
    { cwd: ROOT, encoding: 'utf8', timeout: 600_000, env: { ...process.env, CI: '1' } }
  );
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const counts = out.match(/Tests\s+(.+)/)?.[1]?.trim() ?? '';
  // vitest exits 1 on failure AND on "no test files found" — distinguish them,
  // because the second means the spec's test path is wrong, not that the
  // defence is guarded. Scoring that as KILLED is how a record goes false-green.
  if (/No test files found/i.test(out)) {
    return { passed: false, noTests: true, summary: 'no test files matched' };
  }
  return { passed: res.status === 0, summary: counts || `exit ${res.status}` };
}

// Preflight: the workspace packages must be BUILT. Unbuilt @force/shared makes
// every test that imports it fail to collect, which vitest reports as
// "Tests  no tests" — the runner would then score each defence ERROR for a
// reason that has nothing to do with the defence. Fail loudly here instead.
for (const pkg of ['packages/shared', 'packages/database']) {
  const entry = path.join(ROOT, pkg, 'dist/index.js');
  try {
    readFileSync(entry);
  } catch {
    console.error(
      `${pkg} is not built (${path.relative(ROOT, entry)} missing).\n` +
        `Run:  npm run build -w ${pkg}\n` +
        `Without it every defence scores ERROR on an unrelated import failure.`
    );
    process.exit(2);
  }
}

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
const selected = spec.defences.filter(
  d => (only ? only.includes(d.id) : true) && (tier === 'all' || d.tier === tier)
);

if (selected.length === 0) {
  console.error(`no defences selected (tier=${tier}${only ? `, only=${only.join(',')}` : ''})`);
  process.exit(1);
}

const results = [];
let holes = 0;
for (const [i, entry] of selected.entries()) {
  process.stderr.write(`[${i + 1}/${selected.length}] ${entry.id} … `);
  const r = runOne(entry);
  if (r.verdict !== 'KILLED') holes++;
  process.stderr.write(`${r.verdict}\n`);
  results.push({ ...entry, ...r });
}

const byDomain = new Map();
for (const r of results) {
  if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
  byDomain.get(r.domain).push(r);
}

const lines = [];
lines.push(`# Defence mutation record — FWB`);
lines.push('');
// Deliberately NO timestamp. CI regenerates this file and asserts byte
// equality against the committed copy, so any non-deterministic content turns
// the gate permanently red from the day after it is committed — and the
// instructed remedy (re-run --write and commit) re-stamps it, so the next PR
// on a later day fails again. A permanently-red gate gets deleted, which would
// remove the control this file exists to provide. When it was generated is
// git's job, not the artifact's.
lines.push(
  `Generated by \`scripts/defence-mutation-record.mjs\` — do not hand-edit, re-run the script. ` +
    `Content is derived only from the spec and the measured verdicts, so a regeneration ` +
    `with no code change produces a byte-identical file.`
);
lines.push('');
lines.push(
  `Each row removes one security defence from the source and re-runs the single test that ` +
    `claims to guard it. **KILLED** means the test failed, so the gate is real. **SURVIVED** ` +
    `means the test passed with the defence gone — the test is decorative and the control is ` +
    `unguarded.`
);
lines.push('');
lines.push(
  `Scope: \`${tier}\` tier, ${selected.length} defence(s). ` +
    `${results.length - holes} killed, ${holes} not killed.`
);
lines.push('');

for (const [domain, rows] of [...byDomain].sort()) {
  lines.push(`## ${domain}`);
  lines.push('');
  lines.push('| Defence | Source | Mutation | Verdict |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of rows) {
    const mut = `\`${r.find.replace(/\|/g, '\\|').slice(0, 70)}\` → \`${r.replace.replace(/\|/g, '\\|').slice(0, 40) || '(removed)'}\``;
    const note = r.verdict === 'KILLED' ? '' : `<br>${r.detail}`;
    lines.push(`| ${r.id}<br>${r.why} | \`${r.source}\` | ${mut} | **${r.verdict}**${note} |`);
  }
  lines.push('');
}

const body = lines.join('\n');
if (WRITE) {
  writeFileSync(RECORD_PATH, `${body}\n`);
  console.error(`wrote ${path.relative(ROOT, RECORD_PATH)}`);
} else {
  console.log(body);
}

process.exit(holes === 0 ? 0 : 1);
