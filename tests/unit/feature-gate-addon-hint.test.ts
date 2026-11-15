/**
 * A feature the owner can buy from Settings -> Add-ons answers 403 FEATURE_DISABLED with `details.addonSku`, so the
 * client shows "Get this add-on" instead of a dead end; plan-only features carry no hint; super admin is never gated.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(false) },
}));
vi.mock('@api/services/plan-entitlements', () => ({
  getEntitlements: vi.fn().mockResolvedValue(null),
}));
vi.mock('@api/utils/store-helpers', () => ({ resolvePublicStoreId: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { requireFeature } from '@api/middleware/feature-gate';

async function run(feature: string, role = 'store_admin') {
  let status = 0;
  let body: any;
  const next = vi.fn();
  await requireFeature(feature as never)(
    { user: { role }, params: { storeId: 's1' }, path: '/x' } as never,
    {
      status: (s: number) => ({ json: (b: unknown) => ((status = s), (body = b)) }),
    } as never,
    next
  );
  return { status, body, next };
}

describe('requireFeature add-on hint', () => {
  it('sellable feature: 403 FEATURE_DISABLED with addonSku', async () => {
    const r = await run('loyalty');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FEATURE_DISABLED');
    expect(r.body.error.details.addonSku).toBe('feature:loyalty');
  });
  it('plan-only feature: no addon hint', async () => {
    const r = await run('whatsapp');
    expect(r.status).toBe(403);
    expect(r.body.error.details.addonSku).toBeUndefined();
  });
  it('super admin passes', async () => {
    const r = await run('loyalty', 'super_admin');
    expect(r.next).toHaveBeenCalled();
  });
});
