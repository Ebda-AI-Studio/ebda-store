/**
 * TEN-1 / TEN-6 (audit 2026-11-12, live-state-beats-token-claims, ebda-foundation PR #28): a suspended store is READ-ONLY on
 * every admin route (403 STORE_SUSPENDED, Egyptian-Arabic message), with the billing routes left open only when the suspension
 * has a billing reason; the over-limit exemption matches ONLY the real `/stores/:id/billing` routes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { db, d1 } = vi.hoisted(() => ({
  db: { store: vi.fn(), staff: vi.fn(async () => ({ id: 'm1' })) },
  d1: { on: false, gate: vi.fn() },
}));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    prisma: { store: { findUnique: db.store } },
    withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
      fn({ store: { findUnique: db.store }, storeStaff: { findUnique: db.staff } }),
  };
});
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));
vi.mock('@api/services/platform/access-d1', () => ({
  onAccessD1: async () => d1.on,
  gateRead: (...a: unknown[]) => d1.gate(...a),
}));

const SID = '11111111-1111-4111-8111-111111111111';
type StoreRow = { status: string; billingSuspendedReason: string | null };

async function call(
  store: StoreRow,
  method: string,
  path: string,
  role = 'store_admin',
  userId = 'u1',
  body?: unknown
) {
  const { requireStoreAccess } = await import('@api/middleware/store-access');
  const row = { id: SID, ownerId: 'u1', name: 'S', ...store };
  db.store.mockResolvedValue(row);
  d1.gate.mockResolvedValue({ store: row, isStaff: role === 'staff' });
  const next = vi.fn();
  const [baseUrl, sub] = path.split('|');
  await requireStoreAccess(
    {
      method,
      params: { storeId: SID },
      user: { userId, role },
      baseUrl,
      path: sub ?? '/',
      headers: {},
      body,
    } as never,
    {} as never,
    next
  );
  return next.mock.calls[0]?.[0];
}

const PLATFORM: StoreRow = { status: 'suspended', billingSuspendedReason: null };
const UNPAID: StoreRow = { status: 'suspended', billingSuspendedReason: 'unpaid' };
const OVER: StoreRow = { status: 'suspended', billingSuspendedReason: 'over_store_limit' };
const ACTIVE: StoreRow = { status: 'active', billingSuspendedReason: null };
const W = '/api/v1/stores/s1';

beforeEach(() => {
  db.store.mockReset();
  d1.gate.mockReset();
  d1.on = false;
});

describe.each([
  ['postgres gate', false],
  ['D1 gate', true],
])('TEN-1 suspended store is read-only (%s)', (_n, onD1) => {
  beforeEach(() => {
    d1.on = onD1;
  });

  it.each([
    ['POST', `${W}/integrations/merchant-keys|/`],
    ['PUT', `${W}/products|/p1`],
    ['DELETE', `${W}/staff|/m1`],
    ['POST', `${W}/domains|/`],
    ['PATCH', `${W}/customers|/c1`],
  ])('refuses owner %s with 403 STORE_SUSPENDED and Arabic copy', async (method, path) => {
    const err = await call(PLATFORM, method, path);
    expect(err).toMatchObject({ statusCode: 403, code: 'STORE_SUSPENDED' });
    expect(err.details.messageAr).toMatch(/موقوف/);
    expect(err.details.messageEn).toMatch(/suspended/i);
  });

  it('refuses staff writes too', async () => {
    const err = await call(PLATFORM, 'POST', `${W}/products|/`, 'staff', 'staff1');
    expect(err).toMatchObject({ statusCode: 403, code: 'STORE_SUSPENDED' });
  });

  it('keeps reads open (including exports) for the owner', async () => {
    expect(await call(PLATFORM, 'GET', `${W}/products|/`)).toBeUndefined();
    expect(await call(PLATFORM, 'GET', `${W}/customers|/export.xlsx`)).toBeUndefined();
    expect(await call(UNPAID, 'HEAD', `${W}/products|/`)).toBeUndefined();
  });

  it('billing-reason suspension (unpaid): billing writes stay open, everything else is blocked with the billing copy', async () => {
    expect(await call(UNPAID, 'POST', `${W}/billing|/instapay/claim`)).toBeUndefined();
    const err = await call(UNPAID, 'POST', `${W}/products|/`);
    expect(err).toMatchObject({ statusCode: 403, code: 'STORE_SUSPENDED' });
    expect(err.details).toMatchObject({ reason: 'unpaid' });
    expect(err.details.messageAr).toMatch(/صفحة الفواتير/);
  });

  it('a platform suspension (no billing reason) does NOT open billing writes', async () => {
    const err = await call(PLATFORM, 'POST', `${W}/billing|/checkout`);
    expect(err).toMatchObject({ statusCode: 403, code: 'STORE_SUSPENDED' });
  });

  it('a super-admin is not bound, and an active store is unaffected', async () => {
    expect(await call(PLATFORM, 'PUT', `${W}/products|/p1`, 'super_admin')).toBeUndefined();
    expect(await call(ACTIVE, 'PUT', `${W}/products|/p1`)).toBeUndefined();
  });

  it('a non-owner still gets 403 FORBIDDEN, never a suspension signal (no status oracle)', async () => {
    const err = await call(PLATFORM, 'PUT', `${W}/products|/p1`, 'store_admin', 'stranger');
    expect(err).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });
});

describe('TEN-6 over-limit exemption is anchored to the real billing routes', () => {
  it('allows only /stores/:id/billing[/...]', async () => {
    expect(await call(OVER, 'POST', `${W}/billing|/checkout`)).toBeUndefined();
    expect(await call(OVER, 'POST', `${W}|/billing`)).toBeUndefined();
  });
  it.each([
    `${W}/products|/billing`,
    `${W}/products|/p1/billing/x`,
    `${W}/integrations/merchant-keys|/billing`,
    `/api/v1/stores/s1/notbilling|/x`,
  ])('refuses a write on %s with the 402 upsell', async path => {
    const err = await call(OVER, 'POST', path);
    expect(err).toMatchObject({ statusCode: 402, code: 'STORE_OVER_PLAN_LIMIT' });
  });
});

describe('checkStoreAccess (mixed-audience writes)', () => {
  it('refuses a write on a suspended store only when {write:true}', async () => {
    const { checkStoreAccess } = await import('@api/middleware/store-access');
    db.store.mockResolvedValue({ id: SID, ownerId: 'u1', name: 'S', ...PLATFORM });
    const user = { userId: 'u1', role: 'store_admin' };
    expect(await checkStoreAccess(SID, user)).toMatchObject({ ok: true });
    expect(await checkStoreAccess(SID, user, { write: true })).toMatchObject({
      ok: false,
      status: 403,
      code: 'STORE_SUSPENDED',
    });
  });
});

describe("SUSPEND-REFUND-1: a suspension never strands a customer's money", () => {
  const O = `${W}/orders`;
  it('billing suspension: refunds, refund records and cancels stay open for the merchant', async () => {
    for (const sub of [
      '/o1/refund-via-provider',
      '/o1/instapay-refund',
      '/o1/refund-match-claim',
      '/o1/refresh-refund-status',
    ])
      expect(await call(UNPAID, 'POST', `${O}|${sub}`), sub).toBeUndefined();
    expect(
      await call(UNPAID, 'PUT', `${O}|/o1/status`, 'store_admin', 'u1', { status: 'cancelled' })
    ).toBeUndefined();
    expect(
      await call(UNPAID, 'PUT', `${O}|/o1/status`, 'store_admin', 'u1', { status: 'refunded' })
    ).toBeUndefined();
  });
  it('billing suspension: any other order write (ship, edit) is still blocked', async () => {
    expect(
      await call(UNPAID, 'PUT', `${O}|/o1/status`, 'store_admin', 'u1', { status: 'shipped' })
    ).toMatchObject({ statusCode: 403, code: 'STORE_SUSPENDED' });
    expect(await call(UNPAID, 'POST', `${O}|/o1/mark-paid`)).toMatchObject({
      code: 'STORE_SUSPENDED',
    });
    // the path must be the real order route, not a look-alike segment
    expect(await call(UNPAID, 'POST', `${W}/products|/o1/refund-via-provider`)).toMatchObject({
      code: 'STORE_SUSPENDED',
    });
  });
  it('platform suspension: the merchant cannot refund or cancel', async () => {
    expect(await call(PLATFORM, 'POST', `${O}|/o1/refund-via-provider`)).toMatchObject({
      statusCode: 403,
      code: 'STORE_SUSPENDED',
    });
    expect(
      await call(PLATFORM, 'PUT', `${O}|/o1/status`, 'store_admin', 'u1', { status: 'cancelled' })
    ).toMatchObject({ code: 'STORE_SUSPENDED' });
  });
  it('checkStoreAccess {moneyBack}: billing suspension passes, platform suspension refuses', async () => {
    const { checkStoreAccess } = await import('@api/middleware/store-access');
    const user = { userId: 'u1', role: 'store_admin' };
    db.store.mockResolvedValue({ id: SID, ownerId: 'u1', name: 'S', ...UNPAID });
    expect(await checkStoreAccess(SID, user, { write: true, moneyBack: true })).toMatchObject({
      ok: true,
    });
    expect(await checkStoreAccess(SID, user, { write: true })).toMatchObject({
      ok: false,
      code: 'STORE_SUSPENDED',
    });
    db.store.mockResolvedValue({ id: SID, ownerId: 'u1', name: 'S', ...PLATFORM });
    expect(await checkStoreAccess(SID, user, { write: true, moneyBack: true })).toMatchObject({
      ok: false,
      code: 'STORE_SUSPENDED',
    });
  });
});
