/**
 * Reject vs approve on an add-on claim (race hardening): an approval takes the claim first (`reviewedBy` set while the claim is
 * still `pending`); a reject only acts on a claim nobody has taken, with one compare-and-set, so a granted add-on can never sit
 * behind a rejected claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  claim: null as any,
  markReviewed: vi.fn(),
  effects: vi.fn(),
  beforeReject: null as null | (() => void),
}));

vi.mock('@api/services/storage.service', () => ({}));
vi.mock('@api/services/store.service', () => ({}));
vi.mock('@api/services/feature.service', () => ({}));
vi.mock('@api/services/alerts.service', () => ({}));
vi.mock('@api/services/plan-entitlements', () => ({}));
vi.mock('@api/services/billing/grants.service', () => ({}));
vi.mock('@api/services/billing/subscription-billing.service', () => ({}));
vi.mock('@api/services/billing/manual-config', () => ({}));
vi.mock('@api/services/billing/billing-parent', () => ({}));
vi.mock('@api/services/billing/go-live-verdict', () => ({}));
vi.mock('@api/services/platform/billing-d1', () => ({}));
vi.mock('@api/services/platform/cutover', () => ({}));
vi.mock('@api/lib/definer', () => ({}));
vi.mock('@api/lib/savepoint', () => ({}));
vi.mock('@api/middleware/security', () => ({}));
vi.mock('@api/services/billing/billing-notify', () => ({ runBillingEffects: h.effects }));
vi.mock('@api/services/payment-providers/instapay-receipt.service', () => ({
  InstapayReceiptService: { markReviewed: h.markReviewed },
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  withUser: async (_u: string, fn: () => unknown) => fn(),
  acrossStores: async () => [],
  withStore: async (_id: string, fn: (t: unknown) => unknown) =>
    fn({
      manualPaymentClaim: {
        findFirst: async (a: { where: { status?: string } }) =>
          h.claim && (!a.where.status || h.claim.status === a.where.status) ? { ...h.claim } : null,
        updateMany: async (a: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          h.beforeReject?.();
          const c = h.claim;
          const ok =
            !!c &&
            Object.entries(a.where).every(
              ([k, v]) => k === 'id' || k === 'storeId' || (c[k] ?? null) === v
            );
          if (ok) Object.assign(c, a.data);
          return { count: ok ? 1 : 0 };
        },
      },
      instapayReceipt: { findFirst: async () => null },
    }),
}));

import { rejectClaim } from '@api/services/billing/account.service';

const claim = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  storeId: 's1',
  planCode: 'addon:feature:loyalty',
  status: 'pending',
  reviewedBy: null,
  payerReference: 'TXN123',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.beforeReject = null;
  h.claim = claim();
});

describe('reject never acts under an approval', () => {
  it('a claim nobody has taken is rejected (one compare-and-set)', async () => {
    await rejectClaim({ storeId: 's1', claimId: 'c1', note: 'not received', actorId: 'admin2' });
    expect(h.claim.status).toBe('rejected');
  });

  it('a claim an approval already took (reviewedBy set, still pending) is NOT rejected', async () => {
    h.claim = claim({ reviewedBy: 'admin1' });
    await expect(
      rejectClaim({ storeId: 's1', claimId: 'c1', note: 'not received', actorId: 'admin2' })
    ).rejects.toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });
    expect(h.claim.status).toBe('pending');
    expect(h.effects).not.toHaveBeenCalled(); // no "payment rejected" notice either
  });

  it('an approval that takes the claim between the reject read and its write wins: the reject matches nothing', async () => {
    h.beforeReject = () => Object.assign(h.claim, { reviewedBy: 'admin1' });
    await expect(
      rejectClaim({ storeId: 's1', claimId: 'c1', note: 'not received', actorId: 'admin2' })
    ).rejects.toMatchObject({ code: 'CLAIM_NOT_PENDING' });
    expect(h.claim.status).toBe('pending');
    expect(h.effects).not.toHaveBeenCalled();
  });
});
