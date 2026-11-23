/**
 * The plan-limit engine's decision rule (ported from tests/integration/plan-limits.test.ts, which ran it against a live
 * relational database). The rule itself is pure: `used + delta > limit` refuses, `null` is unlimited, a boolean limit is a
 * capability. A store on its Durable Object counts its products there (Ruling CF-CAP-1); the entitlement read is stubbed here
 * because the plan rows are platform data covered by plan-entitlements and the platform D1 tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  limits: {} as Record<string, unknown>,
  planCode: 'free',
  products: 0,
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({ prisma: {} })
);
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({
    backend: 'do',
    db: { product: { count: async () => h.products }, order: { count: async () => 0 } },
  }),
  storeDb: async () => ({}),
}));
vi.mock('@api/services/plan-entitlements', () => ({
  parseLimits: (x: unknown) => x,
  getEntitlements: async () => ({
    storeId: 's1',
    planCode: h.planCode,
    subscribedPlanCode: h.planCode,
    limits: h.limits,
  }),
}));

import { assertWithinLimit } from '@api/services/plan-limit.service';

const refusal = async (p: Promise<void>) => {
  try {
    await p;
  } catch (e) {
    return e as {
      statusCode?: number;
      status?: number;
      code?: string;
      details?: Record<string, unknown>;
    };
  }
  return null;
};

beforeEach(() => {
  h.limits = { maxProducts: 3, customDomain: false };
  h.planCode = 'tiny';
  h.products = 0;
});

describe('assertWithinLimit numeric ceilings', () => {
  it('allows creates below the limit, fills EXACTLY to it, then refuses with 402 and the upsell details', async () => {
    h.products = 2;
    await expect(assertWithinLimit('s1', 'maxProducts')).resolves.toBeUndefined(); // the 3rd fills it exactly
    h.products = 3;
    const e = await refusal(assertWithinLimit('s1', 'maxProducts'));
    expect(e).not.toBeNull();
    expect(e!.code).toBe('PLAN_LIMIT_REACHED');
    expect(e!.statusCode ?? e!.status).toBe(402);
    expect(e!.details).toMatchObject({
      limitKey: 'maxProducts',
      limit: 3,
      used: 3,
      delta: 1,
      planCode: 'tiny',
    });
    expect(e!.details!.messageEn).toBeTruthy();
    expect(e!.details!.messageAr).toBeTruthy();
  });

  it('counts the WHOLE batch (delta) before anything is written: a batch that overshoots is refused, one that fills is not', async () => {
    h.products = 1;
    const over = await refusal(assertWithinLimit('s1', 'maxProducts', { delta: 3 }));
    expect(over!.details).toMatchObject({ used: 1, delta: 3, limit: 3 });
    await expect(assertWithinLimit('s1', 'maxProducts', { delta: 2 })).resolves.toBeUndefined();
  });

  it('a null ceiling (comped / unlimited) never refuses, however many rows exist', async () => {
    h.limits = { maxProducts: null };
    h.planCode = 'comped';
    h.products = 10_000;
    await expect(assertWithinLimit('s1', 'maxProducts', { delta: 500 })).resolves.toBeUndefined();
  });
});

describe('assertWithinLimit capabilities', () => {
  it('a boolean limit is allowed only when true', async () => {
    const e = await refusal(assertWithinLimit('s1', 'customDomain'));
    expect(e!.code).toBe('PLAN_LIMIT_REACHED');
    expect(e!.details).toMatchObject({ limitKey: 'customDomain', limit: false });
    h.limits = { customDomain: true };
    await expect(assertWithinLimit('s1', 'customDomain')).resolves.toBeUndefined();
  });
});
