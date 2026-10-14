/**
 * #181 — the checkout's loyalty estimate must equal what the server applies.
 *
 * The storefront hardcoded `maxRedeemPercentage: 100` because the public
 * loyalty info omitted it. Under the default 50% cap, a customer redeeming a
 * balance worth more than half the order saw e.g. 2.000 EGP in the summary and
 * was charged 5.000. Now the info route reports the cap and the client runs a
 * step-for-step mirror of `computeRedemption`; this suite runs both over the
 * same grid so any future drift in either one fails here, not at a customer.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', () => ({ prisma: {}, Prisma: {}, withMoneyTx: vi.fn() }));
vi.mock('@api/services/feature.service', () => ({ featureService: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { computeRedemption, DEFAULT_LOYALTY_SETTINGS } =
  await import('@api/services/loyalty.service');
const { estimateLoyaltyRedemption } = await import('@web/app/checkout/_lib/loyaltyEstimate');

describe('checkout loyalty estimate == server computeRedemption', () => {
  it('the reported case: default 50% cap binds, summary matches the charge', () => {
    // 10.000 EGP goods, 8000 points at 1 piastres each (8.000 EGP) requested.
    const server = computeRedemption(DEFAULT_LOYALTY_SETTINGS, 8000, 10000, 8000);
    const client = estimateLoyaltyRedemption(DEFAULT_LOYALTY_SETTINGS, 8000, 10000, 8000);
    expect(server.discountFils).toBe(5000);
    expect(client.loyaltyDiscount).toBe(5000);
    expect(client.pointsToSend).toBe(5000);
  });

  it('agrees over a grid of caps, values, minimums, balances and subtotals', () => {
    let compared = 0;
    for (const maxRedeemPercentage of [0, 10, 33, 50, 100]) {
      for (const pointsValue of [1, 2, 5, 7]) {
        for (const minRedeemPoints of [0, 100, 500]) {
          for (const subtotal of [0, 999, 5000, 12345]) {
            for (const requested of [0, 50, 500, 4000, 20000]) {
              for (const available of [0, 400, 3000, 50000]) {
                const settings = {
                  ...DEFAULT_LOYALTY_SETTINGS,
                  pointsValue,
                  minRedeemPoints,
                  maxRedeemPercentage,
                };
                const server = computeRedemption(settings, requested, subtotal, available);
                const client = estimateLoyaltyRedemption(settings, requested, subtotal, available);
                expect(client.loyaltyDiscount).toBe(server.discountFils);
                expect(client.pointsToSend).toBe(server.pointsToRedeem);
                // What the client SENDS must produce the same discount server-side.
                if (client.pointsToSend > 0) {
                  const onSend = computeRedemption(
                    settings,
                    client.pointsToSend,
                    subtotal,
                    available
                  );
                  expect(onSend.discountFils).toBe(client.loyaltyDiscount);
                }
                compared++;
              }
            }
          }
        }
      }
    }
    expect(compared).toBe(5 * 4 * 3 * 4 * 5 * 4);
  });
});
