/**
 * Ruling BIZ-ALL-5: entitlement decisions read the store's plan ONLY through `readStorePlan` (lib/store-plan.ts). A direct
 * `store.findUnique({ select: { plan: true } })` in entitlement code reads a DO mirror that can be stale (fail-open for a downgrade).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../apps/api/src');
// Entitlement code: the feature map, plan limits, campaign cap, and the plan-gated background scans.
const FILES = [
  'services/plan-entitlements.ts',
  'services/campaign.service.ts',
  'lib/inngest/functions/stock-deadstock-scan.ts',
  'lib/inngest/functions/stock-reorder-scan.ts',
  'lib/inngest/functions/answer-engine-citation-scan.ts',
  'lib/inngest/functions/gsc-ingest.ts',
];
const DIRECT = /store\.findUnique\(\{[^}]*select:\s*\{\s*plan:\s*true\s*\}/s;

describe('single entitlement plan reader', () => {
  for (const f of FILES) {
    it(`${f} reads the plan through readStorePlan`, () => {
      const src = readFileSync(join(root, f), 'utf8');
      expect(src).toMatch(/readStorePlan/);
      expect(src).not.toMatch(DIRECT);
    });
  }
  it('feature.service builds its map from readStorePlan', () => {
    const src = readFileSync(join(root, 'services/feature.service.ts'), 'utf8');
    expect(src).toMatch(/readStorePlan\(tx, storeId\)/);
  });
});
