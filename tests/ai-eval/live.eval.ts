#!/usr/bin/env tsx
/**
 * AI-output evaluation harness — LIVE / MANUAL / NIGHTLY runner.
 *
 * Runs the FULL model-as-judge layer (deterministic checks + a real
 * Gemini call per fixture scoring grounding/relevance/duplication/tone)
 * against every golden AND known-failure fixture in
 * `apps/api/src/lib/ai/eval/fixtures/`.
 *
 * CADENCE — do NOT wire this into the per-push ci.yml. It costs Gemini
 * free-tier quota (one call per model-judge dimension set, per fixture)
 * and the model's scoring is inherently non-deterministic — neither
 * property belongs in a hard per-push gate. Run it:
 *   - manually, any time you change a generator prompt: `npm run ai:eval`
 *   - on a schedule via `.github/workflows/ai-eval-nightly.yml`
 *     (cron + workflow_dispatch, separate from ci.yml)
 *
 * The offline deterministic layer (tests/unit/ai-eval-*.test.ts) is the
 * hard per-push gate — this script is the deeper, slower, quota-costing
 * complement to it.
 *
 * Usage:
 *   npm run ai:eval                  # every fixture, every type
 *   npm run ai:eval -- --type=product-faq   # only one output type
 *
 * Exit code is non-zero when any fixture's overall result doesn't match
 * expectations (golden fails, or a known-failure doesn't reproduce its
 * expected failed checks) — so it can gate the nightly workflow.
 */
import { judgeOutput } from '../../apps/api/src/lib/ai/eval/judge';
import { GOLDEN_CASES, KNOWN_FAILURE_CASES } from '../../apps/api/src/lib/ai/eval/fixtures';
import type { AiOutputType, EvalResult } from '../../apps/api/src/lib/ai/eval/types';

const typeFilter = process.argv.find(a => a.startsWith('--type='))?.split('=')[1] as
  | AiOutputType
  | undefined;

function fmtResult(result: EvalResult): string {
  const lines: string[] = [];
  for (const d of result.deterministic) {
    lines.push(`    [${d.pass ? 'PASS' : 'FAIL'}] deterministic/${d.name} — ${d.reason}`);
  }
  if (result.modelJudge) {
    for (const m of result.modelJudge) {
      lines.push(
        `    [${m.pass ? 'PASS' : 'FAIL'}] judge/${m.name} (score ${m.score}) — ${m.reason}`
      );
    }
  } else {
    lines.push(`    [SKIP] model-judge layer — ${result.skipReason ?? 'unknown reason'}`);
  }
  return lines.join('\n');
}

async function main() {
  const golden = typeFilter ? GOLDEN_CASES.filter(c => c.type === typeFilter) : GOLDEN_CASES;
  const failures = typeFilter
    ? KNOWN_FAILURE_CASES.filter(c => c.type === typeFilter)
    : KNOWN_FAILURE_CASES;

  console.log(
    `AI-eval live run — ${golden.length} golden case(s), ${failures.length} known-failure case(s)`
  );
  if (!process.env.GOOGLE_GENERATIVE_AI_KEY && !process.env.GEMINI_API_KEY) {
    console.warn(
      'WARNING: no GOOGLE_GENERATIVE_AI_KEY / GEMINI_API_KEY set — model-judge dimensions will be skipped, only the deterministic layer will run.'
    );
  }

  let exitCode = 0;

  console.log('\n=== GOLDEN CASES (expected: fully pass) ===');
  for (const c of golden) {
    const result = await judgeOutput({ type: c.type, input: c.input, output: c.output });
    const ok = result.passed;
    if (!ok) exitCode = 1;
    console.log(`\n${ok ? '✓' : '✗'} ${c.type} / ${c.id}`);
    console.log(fmtResult(result));
  }

  console.log('\n=== KNOWN-FAILURE CASES (expected: at least the declared checks fail) ===');
  for (const c of failures) {
    const result = await judgeOutput({ type: c.type, input: c.input, output: c.output });
    const gotExpected = c.expectedFailedChecks.every(name => result.failedChecks.includes(name));
    if (!gotExpected) exitCode = 1;
    console.log(`\n${gotExpected ? '✓' : '✗'} ${c.type} / ${c.id} — ${c.description}`);
    console.log(fmtResult(result));
  }

  console.log(`\nDone. Exit code: ${exitCode}`);
  process.exit(exitCode);
}

main().catch(err => {
  console.error('ai-eval live run crashed:', err);
  process.exit(1);
});
