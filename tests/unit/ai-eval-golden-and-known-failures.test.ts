/**
 * AI-output evaluation harness — deterministic layer, offline, CI-gate.
 *
 * This is the hard gate that runs on every push (wired into `npm run
 * test:unit`): for EVERY AI output type registered in
 * `apps/api/src/lib/ai/eval/criteria.ts`, every golden fixture must pass
 * every deterministic check, and every known-failure fixture (including
 * the real merchant-reported FAQ-duplication regression, PR #538) must
 * fail its expected check(s).
 *
 * The model-as-judge layer (grounding / relevance / tone via a real
 * Gemini call) is NOT exercised here — it costs quota and is
 * non-deterministic, so it only runs via `npm run ai:eval`
 * (tests/ai-eval/live.eval.ts), manually or on the nightly schedule. See
 * that file + .github/workflows/ai-eval-nightly.yml for the cadence.
 */
import { describe, it, expect } from 'vitest';
import { runDeterministicChecks } from '../../apps/api/src/lib/ai/eval/judge';
import { AI_OUTPUT_CRITERIA } from '../../apps/api/src/lib/ai/eval/criteria';
import { GOLDEN_CASES, KNOWN_FAILURE_CASES } from '../../apps/api/src/lib/ai/eval/fixtures';
import type { AiOutputType } from '../../apps/api/src/lib/ai/eval/types';

describe('ai-eval: criteria registry completeness', () => {
  const ALL_TYPES: AiOutputType[] = Object.keys(AI_OUTPUT_CRITERIA) as AiOutputType[];

  it('every registered output type has at least one deterministic check', () => {
    for (const type of ALL_TYPES) {
      expect(
        AI_OUTPUT_CRITERIA[type].deterministic.length,
        `${type} has zero deterministic checks`
      ).toBeGreaterThan(0);
    }
  });

  it('every registered output type has at least one golden fixture', () => {
    const covered = new Set(GOLDEN_CASES.map(c => c.type));
    for (const type of ALL_TYPES) {
      expect(covered.has(type), `${type} has no golden fixture`).toBe(true);
    }
  });
});

describe('ai-eval: golden fixtures pass every deterministic check', () => {
  for (const golden of GOLDEN_CASES) {
    it(`${golden.type} / ${golden.id}`, () => {
      const results = runDeterministicChecks(golden.type, golden.input, golden.output);
      const failed = results.filter(r => !r.pass);
      expect(
        failed,
        `unexpected deterministic failures: ${JSON.stringify(failed, null, 2)}`
      ).toEqual([]);
    });
  }
});

describe('ai-eval: known-failure fixtures are correctly flagged', () => {
  for (const failure of KNOWN_FAILURE_CASES) {
    it(`${failure.type} / ${failure.id} — ${failure.description}`, () => {
      const results = runDeterministicChecks(failure.type, failure.input, failure.output);
      const failedNames = results.filter(r => !r.pass).map(r => r.name);
      for (const expected of failure.expectedFailedChecks) {
        expect(
          failedNames,
          `expected "${expected}" to fail for ${failure.id}, but it passed (all results: ${JSON.stringify(results, null, 2)})`
        ).toContain(expected);
      }
    });
  }

  it('every known-failure fixture declares at least one expected failed check', () => {
    for (const failure of KNOWN_FAILURE_CASES) {
      expect(
        failure.expectedFailedChecks.length,
        `${failure.id} declares no expectedFailedChecks`
      ).toBeGreaterThan(0);
    }
  });
});
