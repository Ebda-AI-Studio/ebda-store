/**
 * #836: a store suspended for billing (a lapsed InstaPay store is suspended `unpaid` when its grace ends) spends no
 * AI. The one gate every AI spend passes (`assertStoreAiEnabled`, asked first by `assertAiQuota` and by the routers'
 * `requireAiEnabled`) now reads the suspension in the same primary-key read as the merchant's switch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  row: { aiFeaturesEnabled: true, status: 'active', billingSuspendedReason: null as string | null },
  counts: 0,
}));

vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ store: { findUnique: async () => ({ ...h.row }) } }),
  storeUpdate: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  withStore: async (_s: string, fn: (tx: unknown) => unknown) => fn({}),
  prisma: {
    aiUsage: {
      count: async () => {
        h.counts++;
        return 0;
      },
    },
  },
}));
// the store's running AI packs (add-ons) are read through the ledger; none here
vi.mock('@api/services/billing/addon-grant', () => ({ activeAddons: async () => [] }));
vi.mock('@api/lib/definer', () => ({
  countAiUsage: async () => {
    h.counts++;
    return 0;
  },
}));

import { assertAiQuota, isAiQuotaCapError } from '@api/lib/ai-quota';
import { isStoreAiEnabled } from '@api/lib/store-ai-switch';

beforeEach(() => {
  h.row = { aiFeaturesEnabled: true, status: 'active', billingSuspendedReason: null };
  h.counts = 0;
});

describe('AI is refused for a billing-suspended store (#836)', () => {
  it.each(['unpaid', 'over_store_limit'])(
    'suspended %s: 402 AI_STORE_BILLING_SUSPENDED, bilingual, before any usage count',
    async reason => {
      h.row.billingSuspendedReason = reason;
      const err = await assertAiQuota({ storeId: 's1' }).catch(e => e);
      expect(err).toMatchObject({ statusCode: 402, code: 'AI_STORE_BILLING_SUSPENDED' });
      expect(err.details?.messageAr).toBeTruthy();
      expect(h.counts).toBe(0);
      // a bulk sweep stops on it instead of failing every remaining product
      expect(isAiQuotaCapError(err)).toBe(true);
    }
  );

  it('control: an active store passes', async () => {
    await expect(assertAiQuota({ storeId: 's1' })).resolves.toBeUndefined();
  });

  it("the merchant's switch read is unchanged: a suspended store with AI on still shows the switch on", async () => {
    h.row.billingSuspendedReason = 'unpaid';
    await expect(isStoreAiEnabled('s1')).resolves.toBe(true);
  });
});
