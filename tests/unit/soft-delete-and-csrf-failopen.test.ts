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
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response, NextFunction } from 'express';

const ROOT = join(__dirname, '../..');

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
    const idx = readFileSync(join(ROOT, 'apps/api/src/index.ts'), 'utf8');
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

  it('CartService excludes soft-deleted products', () => {
    const src = readFileSync(join(ROOT2, 'apps/api/src/services/cart.service.ts'), 'utf8');
    const i = src.indexOf("where: { id: { in: productIds }, storeId, status: 'active'");
    expect(i, 'the cart product lookup moved — re-point this test').toBeGreaterThan(-1);
    expect(src.slice(i, i + 140)).toMatch(/deletedAt:\s*null/);
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

  it('primary add-to-cart (CartService.addItem)', () => {
    const i = cart.indexOf("where: { id: productId, storeId, status: 'active'");
    expect(i, 'the addItem product lookup moved — re-point this test').toBeGreaterThan(-1);
    expect(cart.slice(i, i + 120)).toMatch(/deletedAt:\s*null/);
  });

  it('bulk add-to-cart (CartService.addItems)', () => {
    const i = cart.indexOf("where: { id: { in: productIds }, storeId, status: 'active'");
    expect(i, 'the addItems product lookup moved — re-point this test').toBeGreaterThan(-1);
    expect(cart.slice(i, i + 140)).toMatch(/deletedAt:\s*null/);
  });

  it('admin manual order (OrderService.createManual) — hydrates price AND decrements stock', () => {
    const i = order.indexOf("where: { id: { in: productIds }, storeId, status: 'active'");
    expect(i, 'the createManual product lookup moved — re-point this test').toBeGreaterThan(-1);
    expect(order.slice(i, i + 140)).toMatch(/deletedAt:\s*null/);
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
