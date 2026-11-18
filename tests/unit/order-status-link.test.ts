/** Guest-safe order-status link (Ruling WA-COD-V2-2): token behaviour, the read-only summary, headers, rate limit. */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({ order: vi.fn(), store: vi.fn(), logs: [] as unknown[][] }));
vi.mock('@api/middleware/security', async () => {
  const rateLimit = (
    await vi.importActual<typeof import('express-rate-limit')>('express-rate-limit')
  ).default;
  return {
    makeRateLimitStore: () => undefined,
    rateLimitRedisClient: () => null,
    // the order-status limiter is a PLANNED limiter (PERF-BATCH-1): here the real express-rate-limit with its in-memory store and the SAME options
    plannedRateLimit: (_name: string, opts: Record<string, unknown>) => rateLimit(opts as never),
  };
});
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({ db: { order: { findFirst: h.order } } }),
}));
vi.mock('@api/utils/store-helpers', () => ({
  resolvePublicStoreId: (...a: unknown[]) => h.store(...a),
}));
vi.mock('@api/lib/logger', () => ({
  default: {
    error: (...a: unknown[]) => h.logs.push(a),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { orderStatusPublicRouter } from '@api/routes/order-status-public.routes';
import { orderStatusLimiter } from '@api/middleware/order-status-limiter';
import { assertWhatsAppLinkConfig } from '@api/lib/wa/config';
import {
  signOrderStatusLinkToken,
  verifyOrderStatusLinkToken,
} from '@api/lib/order-status-link-token';

const ORDER_STATUS_LINK_TTL_MS = 14 * 86_400_000; // the documented 14 days, pinned here on purpose
const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const SECRET = 'unit-test-order-status-link-secret-0123456789';

/** Changes the FIRST char (the last char of a 43-char base64url MAC carries padding bits, so editing it can decode to the same bytes). */
const flip = (m: string) => `${m[0] === 'A' ? 'B' : 'A'}${m.slice(1)}`;

const row = {
  orderNumber: '1001',
  status: 'pending',
  paymentStatus: 'unpaid',
  total: 75_050,
  currency: 'EGP',
  createdAt: new Date('2026-11-15T10:00:00Z'),
  locale: 'ar',
  shippingAddress: {
    phone: '01001234567',
    email: 'a@b.co',
    firstName: 'Mona',
    street: 'SECRET-STREET-77',
    city: 'المعادي',
    country: 'EG',
  },
  items: [{ productName: 'Shirt', variantName: 'Large', variantNameAr: 'كبير', quantity: 2 }],
};

function app(limiter?: ReturnType<typeof orderStatusLimiter>) {
  const a = express();
  a.set('trust proxy', true);
  a.use('/public/order-status', orderStatusPublicRouter(limiter));
  return a;
}

beforeAll(() => {
  process.env.ORDER_STATUS_LINK_SECRET = SECRET;
});
beforeEach(() => {
  h.order.mockReset().mockResolvedValue(row);
  h.store.mockReset().mockResolvedValue(STORE);
  h.logs.length = 0;
});

describe('token', () => {
  it('round-trips and carries no PII (two UUIDs, an expiry, a MAC)', () => {
    const t = signOrderStatusLinkToken(STORE, ORDER);
    expect(verifyOrderStatusLinkToken(t)).toEqual({ storeId: STORE, orderId: ORDER });
    expect(t.split('.')).toHaveLength(4);
  });
  it('refuses tampering, expiry, garbage and a different secret', () => {
    const t = signOrderStatusLinkToken(STORE, ORDER);
    const [s, o, e, m] = t.split('.');
    expect(verifyOrderStatusLinkToken(`${s}.${OTHER}.${e}.${m}`)).toBeNull();
    expect(verifyOrderStatusLinkToken(`${OTHER}.${o}.${e}.${m}`)).toBeNull();
    expect(verifyOrderStatusLinkToken(`${s}.${o}.${Number(e) + 5}.${m}`)).toBeNull();
    expect(verifyOrderStatusLinkToken(`${s}.${o}.${e}.${flip(m!)}`)).toBeNull();
    expect(
      verifyOrderStatusLinkToken(
        signOrderStatusLinkToken(STORE, ORDER, Date.now() - ORDER_STATUS_LINK_TTL_MS - 5000)
      )
    ).toBeNull();
    expect(verifyOrderStatusLinkToken('nope')).toBeNull();
    expect(verifyOrderStatusLinkToken(undefined)).toBeNull();
    process.env.ORDER_STATUS_LINK_SECRET = 'a-different-secret-that-is-long-enough-0123456789';
    expect(verifyOrderStatusLinkToken(t)).toBeNull();
    process.env.ORDER_STATUS_LINK_SECRET = SECRET;
  });
  it('lives 14 days and no longer', () => {
    const t = signOrderStatusLinkToken(
      STORE,
      ORDER,
      Date.now() - ORDER_STATUS_LINK_TTL_MS + 60_000
    );
    expect(verifyOrderStatusLinkToken(t)).not.toBeNull();
    expect(verifyOrderStatusLinkToken(t, Date.now() + 120_000)).toBeNull();
  });
});

describe('GET /public/order-status/:token', () => {
  const get = (token: string) => request(app()).get(`/public/order-status/${token}`);

  it('a valid token shows the read-only summary with the area only', async () => {
    const res = await get(signOrderStatusLinkToken(STORE, ORDER));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      orderNumber: '1001',
      status: 'pending',
      total: 75_050,
      currency: 'EGP',
      area: 'المعادي',
      items: [{ name: 'Shirt', variant: 'كبير', quantity: 2 }],
    });
  });
  it('no phone, email, street or name anywhere in the response', async () => {
    const res = await get(signOrderStatusLinkToken(STORE, ORDER));
    const text = JSON.stringify(res.body);
    for (const leak of ['01001234567', 'a@b.co', 'SECRET-STREET-77', 'Mona', 'phone', 'email'])
      expect(text).not.toContain(leak);
  });
  it('sends no-store, no-referrer and noindex headers (also on a 404)', async () => {
    for (const res of [await get(signOrderStatusLinkToken(STORE, ORDER)), await get('bad')]) {
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-robots-tag']).toContain('noindex');
    }
  });
  it('tampered, expired and malformed tokens are a plain 404 and never reach the database', async () => {
    const t = signOrderStatusLinkToken(STORE, ORDER);
    const parts = t.split('.');
    expect((await get(`${parts[0]}.${parts[1]}.${parts[2]}.${flip(parts[3]!)}`)).status).toBe(404);
    expect(
      (
        await get(
          signOrderStatusLinkToken(STORE, ORDER, Date.now() - ORDER_STATUS_LINK_TTL_MS - 5000)
        )
      ).status
    ).toBe(404);
    expect((await get('x')).status).toBe(404);
    expect(h.order).not.toHaveBeenCalled();
  });
  it("another store's token (the request's store differs) is a 404", async () => {
    h.store.mockResolvedValue(OTHER);
    expect((await get(signOrderStatusLinkToken(STORE, ORDER))).status).toBe(404);
    h.store.mockResolvedValue(undefined);
    expect((await get(signOrderStatusLinkToken(STORE, ORDER))).status).toBe(404);
    expect(h.order).not.toHaveBeenCalled();
  });
  it('a vanished order is a 404, and a failure logs no token or address', async () => {
    h.order.mockResolvedValueOnce(null);
    expect((await get(signOrderStatusLinkToken(STORE, ORDER))).status).toBe(404);
    h.order.mockRejectedValueOnce(new Error('db down'));
    const t = signOrderStatusLinkToken(STORE, ORDER);
    expect((await get(t)).status).toBe(500);
    expect(JSON.stringify(h.logs)).not.toContain(t);
  });
  it('is rate limited per IP (429 once the budget is spent)', async () => {
    const a = app(orderStatusLimiter(() => false));
    const t = signOrderStatusLinkToken(STORE, ORDER);
    let last = 200;
    for (let i = 0; i < 31; i++)
      last = (await request(a).get(`/public/order-status/${t}`).set('X-Forwarded-For', '9.9.9.9'))
        .status;
    expect(last).toBe(429);
  });
});

describe('boot guard', () => {
  it('refuses to boot with the WhatsApp queue bound and no (or a short) secret, and passes with one', () => {
    const env = { WA_EVENTS_QUEUE: {} } as never;
    delete process.env.ORDER_STATUS_LINK_SECRET;
    expect(() => assertWhatsAppLinkConfig(env)).toThrow(/ORDER_STATUS_LINK_SECRET/);
    process.env.ORDER_STATUS_LINK_SECRET = 'short';
    expect(() => assertWhatsAppLinkConfig(env)).toThrow(/ORDER_STATUS_LINK_SECRET/);
    process.env.ORDER_STATUS_LINK_SECRET = SECRET;
    process.env.SUITE_BUYER_KEY_SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';
    expect(() => assertWhatsAppLinkConfig(env)).not.toThrow();
  });
});
