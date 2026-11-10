/**
 * Three live-path P2 findings from the audit backlog, verified against the
 * code before fixing and pinned here so they cannot come back.
 *
 * They were picked by PRODUCTION EXPOSURE, not by issue count. The largest
 * cluster in the backlog is `return.service.ts` (16 findings) — and the
 * `returns` table in production is EMPTY, so not one of them has ever
 * executed. These three run on every request, every order, and every
 * checkout respectively.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response, NextFunction } from 'express';

const ROOT = join(__dirname, '../..');

// ── fakes for the soft-delete behaviour tests below ────────────────────────
// A tiny in-memory product table that HONOURS the `where` it is given (id, id
// in, storeId, status, deletedAt: null). Whether a soft-deleted product is
// returned therefore depends on the production query's filter, not on the mock.
const productTable = vi.hoisted(() => {
  const gone = {
    id: 'prod-gone',
    storeId: 'store-1',
    status: 'active', // soft delete leaves status untouched (the premise)
    deletedAt: new Date('2026-01-01'),
  };
  const live = { id: 'prod-live', storeId: 'store-1', status: 'active', deletedAt: null };
  const base = {
    name: 'P',
    nameAr: null,
    price: 1000,
    sku: null,
    moq: null,
    costPrice: null,
    trackInventory: true,
    inventory: 50,
    allowBackorder: false,
    personalisation: null,
    audience: 'public',
    variants: [],
    categories: [],
    _count: { variants: 0 },
  };
  const rows = [gone, live].map(r => ({ ...base, ...r }));
  const matches = (where: any, r: any) =>
    (where.id === undefined ||
      (typeof where.id === 'string' ? where.id === r.id : where.id.in.includes(r.id))) &&
    (where.storeId === undefined || where.storeId === r.storeId) &&
    (where.status === undefined || where.status === r.status) &&
    (where.deletedAt === undefined || where.deletedAt === r.deletedAt);
  return {
    findFirst: async ({ where }: any) => rows.find(r => matches(where, r)) ?? null,
    findMany: async ({ where }: any) => rows.filter(r => matches(where, r)),
  };
});

vi.mock('@ebda/database', () => {
  const prisma: any = {
    cart: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    cartItem: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn(),
    },
    product: productTable,
    productVariant: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    user: { findFirst: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn(),
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return {
    prisma,
    Prisma: {
      TransactionIsolationLevel: { Serializable: 'Serializable', ReadCommitted: 'ReadCommitted' },
    },
    hasTenantContext: () => false,
    runInTenantContext: (_s: string, fn: () => unknown) => fn(),
    withMoneyTx: (_c: unknown, fn: (t: unknown) => unknown) => fn({}),
    OrderStatus: {},
  };
});
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(false) },
}));
vi.mock('@api/services/plan-limit.service', () => ({
  assertOrderAllowed: vi.fn().mockResolvedValue(undefined),
  noteOrderCreated: vi.fn(),
}));
vi.mock('@api/services/gold-rate/gate', () => ({
  assertGoldLinesPriceable: async () => ({ snapshots: new Map(), rateIds: new Map() }),
  assertSameRates: async () => undefined,
  goldQuotesForLines: async () => new Map(),
  goldQuoteKey: (p: string, v: string | null) => `${p}|${v ?? ''}`,
}));
vi.mock('@api/services/gold-rate/public', () => ({
  publicGoldPricingForLines: async () => new Map(),
  publicGoldFields: async () => ({ goldPricing: null }),
}));
vi.mock('@api/services/fiscal-document.service', () => ({ FiscalDocumentService: {} }));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: vi.fn().mockResolvedValue({ ids: [] }), createFunction: vi.fn(() => ({})) },
}));
vi.mock('@api/services/socket.service', () => ({
  socketService: { newOrderNotification: vi.fn(), orderStatusNotification: vi.fn() },
}));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── #1530 · csrfProtection failed OPEN on an unparsed request ──────────────
//
// `if (!req.cookies?.token && !req.cookies?.refresh_token) return next();`
// evaluates TRUE when `req.cookies` is undefined — not empty, never parsed —
// so every state-changing request skips CSRF, silently. Only `cookieParser`
// being mounted ahead of `csrfProtection` prevented it.
describe('#1530 — CSRF does not fail open when cookies were never parsed', () => {
  const src = readFileSync(join(ROOT, 'apps/api/src/middleware/security.ts'), 'utf8');

  it('guards on req.cookies being present BEFORE reading it', () => {
    expect(
      /if \(req\.cookies && !req\.cookies\.token && !req\.cookies\.refresh_token\)/.test(src),
      'the cookieless short-circuit must test `req.cookies &&` first, or an ' +
        'unparsed request is exempted from CSRF entirely'
    ).toBe(true);
  });

  it('no longer uses the optional-chained form that fails open', () => {
    expect(src).not.toMatch(/if \(!req\.cookies\?\.token && !req\.cookies\?\.refresh_token\)/);
  });

  it('cookieParser is still mounted before csrfProtection (what made it survivable)', () => {
    const idx = readFileSync(join(ROOT, 'apps/api/src/app.ts'), 'utf8');
    const cp = idx.indexOf('app.use(cookieParser())');
    const csrf = idx.indexOf('app.use(csrfProtection)');
    expect(cp, 'cookieParser not mounted').toBeGreaterThan(-1);
    expect(csrf, 'csrfProtection not mounted').toBeGreaterThan(-1);
    // The fix means this ordering is no longer load-bearing, but an inversion
    // is still worth knowing about.
    expect(cp).toBeLessThan(csrf);
  });
});

// ── #1409 / #1482 · order-creation product lookup ──────────────────────────
//
// The miss-detection below it exists to catch a product that vanished between
// cart load and order creation. It caught only a HARD delete: soft delete is
// what the admin "delete product" button does, so a soft-deleted product
// resolved, passed the guard, and was ordered.
describe('#1409/#1482 — order creation resolves only live, in-store products', () => {
  const src = readFileSync(join(ROOT, 'apps/api/src/services/order.service.ts'), 'utf8');
  const block = src.slice(src.indexOf('const productInternals = await prisma.product.findMany('));
  const where = block.slice(0, block.indexOf('select:'));

  it('scopes the lookup to the store', () => {
    expect(where, 'productInternals findMany is not store-scoped').toMatch(/storeId/);
  });

  it('excludes soft-deleted products — the delete path merchants actually use', () => {
    expect(where, 'productInternals findMany does not filter deletedAt').toMatch(
      /deletedAt:\s*null/
    );
  });

  it('still keys the map by id, so the miss-detection below keeps working', () => {
    expect(src).toMatch(/productInternalsById\s*=\s*new Map\(productInternals\.map/);
    expect(src).toMatch(/missingProductIds/);
  });
});

// ── #1717 · the limiter I made inert earlier today ─────────────────────────
//
// Switching promotionPreviewLimiter to `skipForLoadTestOrTests` stopped an
// integration suite burning its live 20/min budget — and left nothing able to
// exercise it, so no test pins its configuration. Pin the CONFIG instead: the
// numbers are the contract, and they are what a careless edit would change.
describe('#1717 — promotionPreviewLimiter config stays pinned even though it skips in tests', () => {
  const src = readFileSync(join(ROOT, 'apps/api/src/middleware/security.ts'), 'utf8');
  // Slice to the END of the rateLimit() call, not a fixed character budget —
  // the first version used +1200 chars and silently stopped short of `skip:`
  // and `keyGenerator:`, failing on a config that was actually correct. A
  // window that can truncate its own subject is a test that reports the wrong
  // thing.
  const start = src.indexOf('export const promotionPreviewLimiter');
  const block = src.slice(start, src.indexOf('\n});', start) + 4);

  it('is 20 requests per 60s — the posture couponValidateLimiter documents', () => {
    expect(block).toMatch(/windowMs:\s*60\s*\*\s*1000/);
    expect(block).toMatch(/max:\s*20\b/);
  });

  it('fails OPEN on a Redis store error (deliberate availability tradeoff)', () => {
    expect(block).toMatch(/passOnStoreError:\s*true/);
  });

  it('skips in tests, matching the sibling limiter that wraps the same route', () => {
    expect(block).toMatch(/skip:\s*skipForLoadTestOrTests/);
  });

  it('keys on a normalized IP so an IPv6 /128 cannot rotate past it', () => {
    expect(block).toMatch(/ipKeyGenerator/);
  });
});

// ── the class, not just the reported instance ──────────────────────────────
//
// The audit reported the order-creation lookup. Sweeping the class found the
// SAME hole one step earlier: `CartService` filtered on `status: 'active'`,
// and `ProductService.delete` sets `deletedAt` WITHOUT touching status
// (product.service.ts:999-1002) — so a soft-deleted product stayed
// `status: 'active'` and could be added to a cart.
describe('product soft-delete is honoured everywhere a customer can reach', () => {
  const ROOT2 = join(__dirname, '../..');

  it('soft delete really does leave status untouched (the premise)', () => {
    // If this ever stops being true, the filters below are belt-and-braces
    // rather than load-bearing — and this test should say so rather than
    // quietly keep passing.
    const svc = readFileSync(join(ROOT2, 'apps/api/src/services/product.service.ts'), 'utf8');
    const block = svc.slice(
      svc.indexOf('data: { deletedAt: new Date() }') - 200,
      svc.indexOf('data: { deletedAt: new Date() }') + 60
    );
    expect(block).toContain('deletedAt: new Date()');
    expect(block).not.toMatch(/status:\s*'(archived|draft)'/);
  });

  it('CartService excludes soft-deleted products (bulk lookup)', async () => {
    const { CartService } = await import('@api/services/cart.service');
    const { prisma } = await import('@ebda/database');
    vi.spyOn(CartService, 'getOrCreate').mockResolvedValue({ id: 'cart-1', items: [] } as never);
    (prisma.cartItem.create as ReturnType<typeof vi.fn>).mockClear();
    await CartService.addItems('store-1', 'sess-1', [{ productId: 'prod-gone', quantity: 1 }]);
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });
});

// ── the class, completed after the audit found my sweep incomplete ─────────
//
// My first pass fixed order creation and the BULK cart-sync lookup, and the
// test asserted on the bulk one while the comment claimed the class was swept.
// The audit found two paths still open: the PRIMARY `POST /cart/items` route
// and admin manual-order creation. Both are now covered, and each is asserted
// SEPARATELY so one passing cannot hide another.
describe('soft-deleted products are excluded on EVERY path that can reach a customer', () => {
  const R = join(__dirname, '../..');
  const cart = readFileSync(join(R, 'apps/api/src/services/cart.service.ts'), 'utf8');
  const order = readFileSync(join(R, 'apps/api/src/services/order.service.ts'), 'utf8');

  const R_cart = async () => {
    const { CartService } = await import('@api/services/cart.service');
    const { prisma } = await import('@ebda/database');
    vi.spyOn(CartService, 'getOrCreate').mockResolvedValue({ id: 'cart-1', items: [] } as never);
    return { CartService, create: prisma.cartItem.create as ReturnType<typeof vi.fn> };
  };
  beforeEach(() => vi.clearAllMocks());

  it('primary add-to-cart (CartService.addItem)', async () => {
    const { CartService, create } = await R_cart();
    await expect(CartService.addItem('store-1', 'sess-1', 'prod-gone', 1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
    expect(create).not.toHaveBeenCalled();
    // control: the live product on the same path is added.
    await CartService.addItem('store-1', 'sess-1', 'prod-live', 1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('bulk add-to-cart (CartService.addItems)', async () => {
    const { CartService, create } = await R_cart();
    await CartService.addItems('store-1', 'sess-1', [
      { productId: 'prod-gone', quantity: 1 },
      { productId: 'prod-live', quantity: 1 },
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ productId: 'prod-live' }) })
    );
  });

  it('admin manual order (OrderService.createAdminOrder) — hydrates price AND decrements stock', async () => {
    const { OrderService } = await import('@api/services/order.service');
    await expect(
      OrderService.createAdminOrder(
        'store-1',
        'admin-1',
        {
          items: [{ productId: 'prod-gone', quantity: 1 }],
          customerName: 'X',
          customerEmail: 'x@example.com',
        } as never,
        { role: 'store_admin' }
      )
    ).rejects.toMatchObject({ statusCode: 404, code: 'PRODUCT_NOT_FOUND' });
  });

  it('checkout refusal carries ids in `details`, not interpolated into the message', () => {
    // A raw UUID list is neither translatable nor useful to a shopper, and
    // CLAUDE.md forbids user-facing strings outside LanguageContext.
    const i = order.indexOf("'PRODUCT_NO_LONGER_AVAILABLE'");
    expect(i).toBeGreaterThan(-1);
    const block = order.slice(i, i + 400);
    expect(block).toMatch(/\{ productIds: missingProductIds \}/);
    expect(block, 'ids must not be interpolated into the message').not.toMatch(
      /\$\{missingProductIds\.join/
    );
  });

  it('the client has a case for it — otherwise the fix creates a dead end', () => {
    // The server refusal is correct; shipping it WITHOUT the client half turns
    // a silent bug into an unrecoverable "please try again" loop.
    const cc = readFileSync(join(R, 'apps/web/src/app/checkout/CheckoutClient.tsx'), 'utf8');
    expect(cc).toMatch(/case PRODUCT_NO_LONGER_AVAILABLE/);
    expect(cc).toMatch(/productUnavailableCopy/);
  });
});
