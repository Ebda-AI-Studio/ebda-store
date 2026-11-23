/**
 * The merchant's AI switch (`stores.ai_features_enabled`): off means NO AI call for that store, from any entry
 * point. One function owns the question (`assertStoreAiEnabled`), `assertAiQuota` asks it first (so every sweep
 * and every service call is covered), the HTTP routers mount `requireAiEnabled` (so a cached answer is not served
 * either), and a sweep treats the refusal as "stop", not as a per-product failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ findUnique: vi.fn(), countAiUsage: vi.fn(), count: vi.fn() }));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    prisma: { store: { findUnique: m.findUnique }, aiUsage: { count: m.count } },
  };
});
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ store: { findUnique: m.findUnique } }),
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: (_id: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/lib/definer', () => ({ countAiUsage: m.countAiUsage }));

import {
  AI_DISABLED_BY_MERCHANT_CODE,
  STORE_AI_SUSPENDED_CODE,
  assertStoreAiEnabled,
  isStoreAiEnabled,
  requireAiEnabled,
} from '@api/lib/store-ai-switch';
import { assertAiQuota, isAiQuotaCapError } from '@api/lib/ai-quota';

beforeEach(() => {
  vi.resetAllMocks();
  m.countAiUsage.mockResolvedValue(0);
  m.count.mockResolvedValue(0);
});

describe('isStoreAiEnabled / assertStoreAiEnabled', () => {
  it('true only when the store row says so; a missing store is NOT enabled (fail closed)', async () => {
    m.findUnique.mockResolvedValueOnce({ aiFeaturesEnabled: true, status: 'active' });
    expect(await isStoreAiEnabled('s1')).toBe(true);
    m.findUnique.mockResolvedValueOnce({ aiFeaturesEnabled: false, status: 'active' });
    expect(await isStoreAiEnabled('s1')).toBe(false);
    m.findUnique.mockResolvedValueOnce(null);
    expect(await isStoreAiEnabled('s1')).toBe(false);
  });
  it('throws a 403 with a stable code when off, and reads only that store', async () => {
    m.findUnique.mockResolvedValue({ aiFeaturesEnabled: false, status: 'active' });
    await expect(assertStoreAiEnabled('s1')).rejects.toMatchObject({
      statusCode: 403,
      code: AI_DISABLED_BY_MERCHANT_CODE,
    });
    expect(m.findUnique.mock.calls[0][0].where).toEqual({ id: 's1' });
  });
});

describe('assertAiQuota asks the switch first', () => {
  it('off: refuses before any quota is counted (no AI spend)', async () => {
    m.findUnique.mockResolvedValue({ aiFeaturesEnabled: false, status: 'active' });
    await expect(assertAiQuota({ storeId: 's1' })).rejects.toMatchObject({
      code: AI_DISABLED_BY_MERCHANT_CODE,
    });
    expect(m.countAiUsage).not.toHaveBeenCalled();
  });
  it('on: continues to the normal quota checks', async () => {
    m.findUnique.mockResolvedValue({ aiFeaturesEnabled: true, status: 'active' });
    await expect(assertAiQuota({ storeId: 's1' })).resolves.toBeUndefined();
    expect(m.countAiUsage).toHaveBeenCalled();
  });
  it('a sweep stops on it instead of failing every product', () => {
    expect(isAiQuotaCapError({ code: AI_DISABLED_BY_MERCHANT_CODE })).toBe(true);
  });
});

describe('an admin-SUSPENDED store is refused AI spend (Ruling SUSPEND-AI-1)', () => {
  it('assertStoreAiEnabled: suspended (or any non-active / unknown status) is a 403 STORE_AI_SUSPENDED even with the merchant switch on', async () => {
    for (const status of ['suspended', 'inactive', 'deleted', null]) {
      m.findUnique.mockResolvedValue({ aiFeaturesEnabled: true, status });
      await expect(assertStoreAiEnabled('s1')).rejects.toMatchObject({
        statusCode: 403,
        code: STORE_AI_SUSPENDED_CODE,
      });
    }
  });
  it('a suspended store is never told to turn AI on: suspended with the merchant switch OFF is still STORE_AI_SUSPENDED', async () => {
    m.findUnique.mockResolvedValue({ aiFeaturesEnabled: false, status: 'suspended' });
    await expect(assertStoreAiEnabled('s1')).rejects.toMatchObject({
      statusCode: 403,
      code: STORE_AI_SUSPENDED_CODE,
    });
  });
  it('a billing-suspended store (status suspended + a reason) keeps its 402 Billing hint, switch on or off', async () => {
    for (const aiFeaturesEnabled of [true, false]) {
      m.findUnique.mockResolvedValue({
        aiFeaturesEnabled,
        status: 'suspended',
        billingSuspendedReason: 'unpaid',
      });
      await expect(assertStoreAiEnabled('s1')).rejects.toMatchObject({
        statusCode: 402,
        code: 'AI_STORE_BILLING_SUSPENDED',
      });
    }
  });
  it('an active store with the switch off is the merchant-switch 403', async () => {
    m.findUnique.mockResolvedValue({ aiFeaturesEnabled: false, status: 'active' });
    await expect(assertStoreAiEnabled('s1')).rejects.toMatchObject({
      statusCode: 403,
      code: AI_DISABLED_BY_MERCHANT_CODE,
    });
  });
  it('the merchant switch (what the AI settings page shows) is NOT changed by the suspension', async () => {
    m.findUnique.mockResolvedValue({ aiFeaturesEnabled: true, status: 'suspended' });
    expect(await isStoreAiEnabled('s1')).toBe(true);
  });
  it('the interactive route guard refuses it', async () => {
    m.findUnique.mockResolvedValue({ aiFeaturesEnabled: true, status: 'suspended' });
    const next = vi.fn();
    await requireAiEnabled({ params: { storeId: 's1' } } as never, {} as never, next);
    expect(next.mock.calls[0][0]).toMatchObject({ code: STORE_AI_SUSPENDED_CODE });
  });
  it('a background bulk AI job (assertAiQuota bulk) refuses BEFORE it counts or reserves anything', async () => {
    m.findUnique.mockResolvedValue({ aiFeaturesEnabled: true, status: 'suspended' });
    await expect(assertAiQuota({ storeId: 's1', bulk: true })).rejects.toMatchObject({
      code: STORE_AI_SUSPENDED_CODE,
    });
    expect(m.countAiUsage).not.toHaveBeenCalled();
    expect(m.count).not.toHaveBeenCalled();
  });
  it('reads the status uncached: a store suspended between two calls is refused on the very next one', async () => {
    m.findUnique.mockResolvedValueOnce({ aiFeaturesEnabled: true, status: 'active' });
    await expect(assertStoreAiEnabled('s1')).resolves.toBeUndefined();
    m.findUnique.mockResolvedValueOnce({ aiFeaturesEnabled: true, status: 'suspended' });
    await expect(assertStoreAiEnabled('s1')).rejects.toMatchObject({
      code: STORE_AI_SUSPENDED_CODE,
    });
    expect(m.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('requireAiEnabled (HTTP)', () => {
  const run = async (storeId: string | undefined) => {
    const next = vi.fn();
    await requireAiEnabled({ params: { storeId } } as never, {} as never, next);
    return next;
  };
  it('passes through when on', async () => {
    m.findUnique.mockResolvedValue({ aiFeaturesEnabled: true, status: 'active' });
    const next = await run('s1');
    expect(next).toHaveBeenCalledWith();
  });
  it('hands the 403 to the error handler when off, and never lets a missing store id through', async () => {
    m.findUnique.mockResolvedValue({ aiFeaturesEnabled: false, status: 'active' });
    expect((await run('s1')).mock.calls[0][0]).toMatchObject({
      code: AI_DISABLED_BY_MERCHANT_CODE,
    });
    expect((await run(undefined)).mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
