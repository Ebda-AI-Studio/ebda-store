/**
 * Smart Layer E0: the coverage guard (plan 4 SL-SCOPE-1). Every live, non-forbidden capability of the Store registry has an assistant tool, or is deep-link-only
 * (a secret keeps it out of chat), or is owned by another plan. The ones that do not yet are listed in `coverage-baseline.json`, a SHRINK-ONLY ratchet
 * (same `applyBaseline` / `baselineGrowth` as the capability guards): a new gap fails, a closed gap must leave the list in the same PR, and the list may
 * never grow against the base branch. A capability that flips `planned` -> `live` without a tool is not in the baseline, so it fails: that is how
 * "when built" capabilities get their tool in their own shipping PR.
 * Write the baseline after closing gaps:  COVERAGE_WRITE_BASELINE=1 npx vitest run tests/unit/assistant-coverage.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegistryCap, ToolSpec } from '@ebda/shared/smart-layer';
import {
  applyBaseline,
  baselineGrowth,
  violationId,
} from '../../packages/shared/src/foundation/ratchet';
import type { Violation } from '../../packages/shared/src/foundation/capability';

vi.mock('@api/lib/repo-factory', () => ({
  storeDb: vi.fn(),
  storeSmartLayer: vi.fn(),
  storeRepo: vi.fn(),
}));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => undefined }));
vi.mock('@api/lib/search/embedding-provider', () => ({ getEmbeddingProvider: () => null }));

import { changeTools } from '@api/smart-layer/tools/change-tools';
import { readTools } from '@api/smart-layer/tools/read.tools';
import { storeRegistry } from '@api/smart-layer/registry';
import { DEEP_LINK_ONLY, OWNED_ELSEWHERE } from '@api/smart-layer/deep-link-only';

const BASELINE_PATH = 'apps/api/src/smart-layer/coverage-baseline.json';
const ROOT = join(__dirname, '../..');

/** Live, non-forbidden capability ids with no tool, not deep-link-only and not owned by another plan. */
function uncovered(
  caps: Iterable<Pick<RegistryCap, 'id' | 'status' | 'policy'>>,
  tools: Pick<ToolSpec, 'capabilityId'>[],
  deepLinkOnly: Record<string, unknown>,
  ownedElsewhere: Record<string, string>
): string[] {
  const covered = new Set(tools.map(t => t.capabilityId));
  return [...caps]
    .filter(c => c.status === 'live' && c.policy !== 'forbidden')
    .filter(c => !covered.has(c.id) && !(c.id in deepLinkOnly) && !(c.id in ownedElsewhere))
    .map(c => c.id)
    .sort();
}
const asViolations = (ids: string[]): Violation[] =>
  ids.map(id => ({
    rule: 'uncovered',
    key: id,
    message: `${id} is live and has no assistant tool (add a tool, DEEP_LINK_ONLY or OWNED_ELSEWHERE)`,
  }));
const readBaseline = (): string[] =>
  (JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), 'utf8')) as { ids: string[] }).ids;

const registry = storeRegistry();
const tools = [
  ...readTools({
    helpSearch: async () => [],
    registry,
    assistantCapability: 'ai.merchant-assistant',
  }),
  ...changeTools(),
];
const real = () => uncovered(registry.caps.values(), tools, DEEP_LINK_ONLY, OWNED_ELSEWHERE);

describe('assistant coverage guard (Store)', () => {
  it('every uncovered live capability is in the shrink-only baseline and every baseline id is still uncovered', () => {
    const r = applyBaseline(asViolations(real()), readBaseline());
    expect(r.fresh.map(violationId)).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  it('DEEP_LINK_ONLY and OWNED_ELSEWHERE name live capabilities that really have no tool (no stale or double-booked entry)', () => {
    const covered = new Set(tools.map(t => t.capabilityId));
    for (const id of [...Object.keys(DEEP_LINK_ONLY), ...Object.keys(OWNED_ELSEWHERE)]) {
      const cap = registry.caps.get(id);
      expect(cap?.status, id).toBe('live');
      expect(cap?.policy, id).not.toBe('forbidden');
      expect(covered.has(id), `${id} has a tool, drop it from the exception list`).toBe(false);
    }
    for (const id of Object.keys(DEEP_LINK_ONLY)) expect(id in OWNED_ELSEWHERE, id).toBe(false);
  });

  it('the baseline is sorted and duplicate-free', () => {
    const b = readBaseline();
    expect(b).toEqual([...new Set(b)].sort());
  });

  it('the baseline cannot grow against the base branch (when the base already has it)', () => {
    let base: string[] | null = null;
    for (const ref of ['origin/main', 'main'])
      try {
        base = (
          JSON.parse(
            execFileSync('git', ['show', `${ref}:${BASELINE_PATH}`], {
              cwd: ROOT,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            })
          ) as { ids: string[] }
        ).ids;
        break;
      } catch {
        /* the base has no baseline yet (this is the PR that creates it), or no such ref in a shallow checkout */
      }
    if (!base) return;
    expect(baselineGrowth(readBaseline(), base)).toEqual([]);
  });
});

describe('uncovered() (mutation proofs: the guard can fail)', () => {
  const cap = (
    id: string,
    status: RegistryCap['status'] = 'live',
    policy: RegistryCap['policy'] = 'confirm'
  ) => ({ id, status, policy });
  it('a live confirm capability with no tool fails', () => {
    expect(uncovered([cap('x.confirm')], [], {}, {})).toEqual(['x.confirm']);
    expect(applyBaseline(asViolations(['x.confirm']), []).fresh).toHaveLength(1);
  });
  it('a deep-link-only capability passes without a tool', () => {
    expect(
      uncovered([cap('account.password')], [], { 'account.password': { secret: 'p' } }, {})
    ).toEqual([]);
  });
  it('a capability owned by another plan passes without a tool', () => {
    expect(
      uncovered(
        [cap('builder.edit-page', 'live', 'preview')],
        [],
        {},
        { 'builder.edit-page': 'page-builder-v2' }
      )
    ).toEqual([]);
  });
  it('a forbidden capability never needs a tool, and a planned one is not due yet', () => {
    expect(
      uncovered([cap('platform.x', 'live', 'forbidden'), cap('self.y', 'planned')], [], {}, {})
    ).toEqual([]);
  });
  it('a planned capability that flips to live without a tool is not in the baseline, so it fails', () => {
    const before = uncovered([cap('self.y', 'planned')], [], {}, {});
    const after = uncovered([cap('self.y', 'live')], [], {}, {});
    expect(before).toEqual([]);
    expect(applyBaseline(asViolations(after), before).fresh.map(violationId)).toEqual([
      'uncovered|self.y',
    ]);
  });
  it('a baseline id whose gap closed is stale and must leave the baseline', () => {
    expect(applyBaseline(asViolations([]), ['uncovered|x.done']).stale).toEqual([
      'uncovered|x.done',
    ]);
  });
  it('the baseline cannot grow', () => {
    expect(baselineGrowth(['a', 'b'], ['a'])).toEqual(['b']);
    expect(baselineGrowth(['a'], ['a', 'b'])).toEqual([]);
  });
});

describe.skipIf(process.env.COVERAGE_WRITE_BASELINE !== '1')('write the coverage baseline', () => {
  it('writes apps/api/src/smart-layer/coverage-baseline.json from the current gaps', () => {
    writeFileSync(
      join(ROOT, BASELINE_PATH),
      `${JSON.stringify({ ids: real().map(id => `uncovered|${id}`) }, null, 2)}\n`
    );
  });
});
