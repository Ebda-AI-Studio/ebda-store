#!/usr/bin/env node
/**
 * MERGE-QUEUE-1: the verdict of the `Merge queue gate` check.
 *
 * GitHub evaluates a ruleset's required status checks BY NAME on the pull request AND on the merge group's temporary branch. The
 * full lane (Build, Unit Tests, Integration, E2E, Security Audit, ...) never reports on a pull request and the pull-request lane
 * (Unit Tests (affected), App builds (affected), the deploy-change check) never reports on a merge group, so neither kind can be
 * required directly. This one check exists on both:
 *   - pull_request: a plain success (the pull-request lane has its own checks; the drain's merge-gate.sh judges those);
 *   - merge_group:  success only when EVERY full-lane job it depends on succeeded. A failure, a cancelled run or a SKIPPED job all
 *                   fail it (a full-lane job that silently did not run must never read as "green").
 * Any other event never runs this job (the job's own `if`).
 *
 * Input: EVENT = github.event_name, NEEDS = toJSON(needs) (job id -> { result }). Exit 0 = pass, 1 = fail.
 */
import { DOCS_ONLY_SKIPPABLE_JOBS, HEAVY_ONLY_JOBS } from './mq-scope.mjs';

export function verdict(event, needs, opts = {}) {
  // MQ-SCOPE-1: when scripts/ci/mq-scope.mjs said heavy=false, these jobs were skipped ON PURPOSE and `skipped` counts as success for them only.
  // CRITICAL-PATH-1: a STRICTLY docs-only merge group (docs_only=true, which implies heavy=false) also skips the workerd dry-run on purpose.
  const lightSkippable = new Set();
  if (opts.heavy === 'false') for (const j of HEAVY_ONLY_JOBS) lightSkippable.add(j);
  if (opts.heavy === 'false' && opts.docsOnly === 'true')
    for (const j of DOCS_ONLY_SKIPPABLE_JOBS) lightSkippable.add(j);
  if (event === 'pull_request')
    return { ok: true, message: 'pull request: the full lane runs on the merge group' };
  if (event !== 'merge_group')
    return {
      ok: false,
      message: `unexpected event ${event}: this check belongs to pull_request and merge_group only`,
    };
  const ids = needs && typeof needs === 'object' ? Object.keys(needs) : [];
  if (ids.length === 0)
    return {
      ok: false,
      message: 'no upstream jobs reported: refusing to call an empty merge group green',
    };
  const bad = ids
    .filter(
      id =>
        needs[id]?.result !== 'success' &&
        !(lightSkippable.has(id) && needs[id]?.result === 'skipped')
    )
    .map(id => `${id}=${needs[id]?.result ?? 'missing'}`);
  if (bad.length)
    return { ok: false, message: `full lane not green on the merge group: ${bad.join(', ')}` };
  return { ok: true, message: `full lane green on the merge group (${ids.length} jobs)` };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let needs = null;
  try {
    needs = JSON.parse(process.env.NEEDS ?? 'null');
  } catch {
    /* an unreadable needs object is "no upstream jobs": fails closed on a merge group */
  }
  const v = verdict(process.env.EVENT ?? '', needs, {
    heavy: needs?.['tested-tree']?.outputs?.heavy,
    docsOnly: needs?.['tested-tree']?.outputs?.docs_only,
  });
  console.log(`merge-queue-gate: ${v.message}`);
  process.exit(v.ok ? 0 : 1);
}
