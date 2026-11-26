/**
 * "Not tracked for guest checkout" instead of a false 0.
 *
 * Owner decision 2026-09-30: no guest contact capture at checkout. Abandoned
 * carts are only recorded when the cart has a customer contact, so on a store
 * that takes guest orders every metric built on `abandoned_carts` —
 * abandoned-cart stats, the funnel's "checkouts started" and "abandoned" —
 * reads 0 whatever shoppers do (live: demo-store 0 checkouts started against 55
 * completed orders in 30 days). The API now reports `guestCheckout` (the store
 * took a guest order in the window) and the admin shows those zeros as
 * "not tracked for guest checkout" (en + ar). A non-zero count on such a store
 * is real but registered-customers-only, and says so.
 *
 * Mutation proof: make `isUntrackedForGuests` return false → the StatsGrid
 * case goes red.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

const { findFirst, getStats } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  getStats: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: { order: { findFirst } },
}));
vi.mock('@api/services/abandoned-cart.service', () => ({
  abandonedCartService: { getStats },
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (_req: any, _res: any, next: any) => next(),
  authorize:
    (..._r: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/config', () => ({ config: {} }));

import { isUntrackedForGuests } from '@admin/lib/guest-checkout';
import { StatsGrid } from '@admin/app/stores/[id]/abandoned-carts/_components/StatsGrid';
import { storeTakesGuestOrders } from '@api/lib/guest-checkout';

const ZERO = { totalAbandoned: 0, totalRecovered: 0, recoveryRate: 0, recoveredRevenue: 0 };
const NOT_TRACKED = 'components.guestCheckout.abandonedExplainer';

describe('isUntrackedForGuests', () => {
  it('0 on a guest-checkout store is not tracked; anything else is a real count', () => {
    expect(isUntrackedForGuests(0, true)).toBe(true);
    expect(isUntrackedForGuests(3, true)).toBe(false);
    expect(isUntrackedForGuests(0, false)).toBe(false);
    expect(isUntrackedForGuests(0, undefined)).toBe(false);
  });
});

describe('abandoned-cart StatsGrid', () => {
  it('guest-checkout store with nothing recorded → "not tracked", no false 0', () => {
    const html = renderToStaticMarkup(<StatsGrid stats={ZERO} guestCheckout />);
    expect(html.match(new RegExp(NOT_TRACKED, 'g'))).toHaveLength(1);
    expect(html.match(/>—</g)).toHaveLength(4);
    expect(html).not.toMatch(/>0<|>0%</);
  });

  it('registered-only store → real zeros', () => {
    const html = renderToStaticMarkup(<StatsGrid stats={ZERO} guestCheckout={false} />);
    expect(html).not.toContain(NOT_TRACKED);
    expect(html).toContain('>0<');
  });

  it('guest-checkout store with some registered carts → numbers, labelled registered-only', () => {
    const html = renderToStaticMarkup(
      <StatsGrid stats={{ ...ZERO, totalAbandoned: 4 }} guestCheckout />
    );
    expect(html).not.toContain(NOT_TRACKED);
    expect(html).toContain('>4<');
    expect(html).toContain('components.guestCheckout.registeredOnly');
  });

  // issue 2035: the API reports recovery as null (not tracked). The three
  // recovery cards must say so — never "0", "0%" or "0.000 EGP".
  it('null recovery figures render "not tracked", never a false 0', () => {
    const html = renderToStaticMarkup(
      <StatsGrid
        stats={{
          totalAbandoned: 7,
          totalRecovered: null,
          recoveryRate: null,
          recoveredRevenue: null,
        }}
        guestCheckout={false}
      />
    );
    expect(html).toContain('>7<');
    expect(html.match(/abandonedCarts\.stats\.recoveryNotTracked/g)).toHaveLength(3);
    expect(html).not.toMatch(/>0<|>0%<|baseValue/);
  });
});

describe('storeTakesGuestOrders', () => {
  beforeEach(() => findFirst.mockReset());

  it('probes for an order with no customer in the window', async () => {
    findFirst.mockResolvedValue({ id: 'o1' });
    const since = new Date('2026-07-01T00:00:00Z');
    await expect(storeTakesGuestOrders('s1', since)).resolves.toBe(true);
    expect(findFirst.mock.calls[0][0].where).toEqual({
      storeId: 's1',
      customerId: null,
      createdAt: { gte: since },
    });
    findFirst.mockResolvedValue(null);
    await expect(storeTakesGuestOrders('s1', since)).resolves.toBe(false);
  });
});

describe('GET /abandoned-carts/stats reports guestCheckout', () => {
  let app: Express;
  beforeAll(async () => {
    const { default: router } = await import('@api/routes/abandoned-cart.routes');
    app = express();
    app.use('/stores', router);
  });

  it('true when the store took a guest order in the look-back', async () => {
    getStats.mockResolvedValue(ZERO);
    findFirst.mockResolvedValue({ id: 'guest-order' });
    const res = await request(app).get('/stores/s1/abandoned-carts/stats');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ stats: ZERO, guestCheckout: true });
  });

  it('false for a registered-only store', async () => {
    getStats.mockResolvedValue(ZERO);
    findFirst.mockResolvedValue(null);
    const res = await request(app).get('/stores/s1/abandoned-carts/stats');
    expect(res.body.data.guestCheckout).toBe(false);
  });
});
