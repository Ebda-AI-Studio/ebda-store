/**
 * Ruling BIZ-ALL-1 (Ahmad 2026-11-15): a Business store resolves EVERY registry feature ON, except the two documented
 * exclusions; the keys that are opt-in by design stay OFF until someone switches them on. Enumerates the registry, never a hand list.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withStore: vi.fn(),
}));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/services/store.service', () => ({ bustStoreCaches: vi.fn() }));
vi.mock('@api/services/plan-entitlements', () => ({ getAutomationFlags: vi.fn() }));
vi.mock('@api/services/plan-sync', () => ({ syncSubscriptionFromLegacyPlan: vi.fn() }));
vi.mock('@api/lib/store-plan', () => ({ readStorePlan: vi.fn(), reconcileDoPlan: vi.fn() }));
vi.mock('@api/lib/repo-factory', () => ({ storeUpdate: vi.fn(), syncStoreEntitlement: vi.fn() }));
vi.mock('@api/lib/public-cache', () => ({ invalidateStoreProductCaches: vi.fn() }));

import { FEATURE_KEYS_ARRAY, BUSINESS_BASELINE_EXCLUSIONS, type FeatureKey } from '@ebda/shared';
import { featureService } from '@api/services/feature.service';

const businessFlags = {
  abandonedCartAutomation: true,
  whatsappAutomation: true,
  brandingRemoval: true,
  apiAccess: true,
  wholesalePricing: true,
  mcpAccess: true,
};
const resolve = (
  plan: 'starter' | 'professional' | 'enterprise',
  flags: typeof businessFlags | null
) => (featureService as any).rowsToMap(plan, [], flags) as Record<FeatureKey, boolean>;

describe('Business plan resolves every feature', () => {
  it('every registry key is ON for a Business store, bar the documented exclusions', () => {
    const map = resolve('enterprise', businessFlags);
    const off = FEATURE_KEYS_ARRAY.filter(k => !map[k]);
    expect(off.sort()).toEqual(Object.keys(BUSINESS_BASELINE_EXCLUSIONS).sort());
  });

  it('opt-in keys default OFF even on Business: the open-writes escape hatch and the Ebda Chat key', () => {
    const map = resolve('enterprise', businessFlags);
    expect(map.agent_checkout_open_writes).toBe(false);
    expect(map.whatsapp).toBe(false);
  });

  it('a super-admin StoreFeature row still wins both ways on Business', () => {
    const map = (featureService as any).rowsToMap(
      'enterprise',
      [
        { featureKey: 'floating_widget', enabled: false },
        { featureKey: 'agent_checkout_open_writes', enabled: true },
      ],
      businessFlags
    );
    expect(map.floating_widget).toBe(false);
    expect(map.agent_checkout_open_writes).toBe(true);
  });

  it('Basic and Growth do not gain Business-only features', () => {
    for (const plan of ['starter', 'professional'] as const) {
      const map = resolve(plan, { ...businessFlags, wholesalePricing: false });
      expect(map.floating_widget).toBe(false);
      expect(map.bundles).toBe(false);
      expect(map['b2b.wholesale']).toBe(false);
    }
  });
});
