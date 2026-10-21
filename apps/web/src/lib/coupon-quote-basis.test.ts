import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  couponQuoteBasis,
  couponQuoteCartItems,
  couponQuoteLooseFields,
} from './coupon-quote-basis';

/**
 * P0-1 (final review) — the storefront half of "quote must equal charge".
 *
 * `OrderService.create` applies a coupon to the LOOSE cart lines only
 * (Ruling B1: a coupon never stacks onto an already-discounted box). Both
 * storefront surfaces that call `POST /coupons/validate` must therefore send
 * the loose-items-only subtotal as `orderTotal`. They previously sent
 * `CartContext.total`, which folds the bundle in — so a bundle-only cart was
 * shown a 1.200 EGP discount and charged the full 12.000.
 *
 * The server side of this is asserted behaviourally in
 * `tests/unit/bundle-coupon-quote.test.ts`. The ARITHMETIC is now asserted
 * behaviourally too, against the real `couponQuoteBasis` function (P2-c,
 * scoped re-review) — the previous version of this file asserted the WIRING
 * only (a source-text grep for `${itemsVar}.reduce`), which stayed green
 * even if someone edited the reduce to `sum + item.price`, dropping
 * `* item.quantity` and silently re-opening display≠charge for any loose
 * line with quantity > 1. What no DOM harness in this repo can render (see
 * `apps/web/src/lib/bundles-nav.ts`'s doc comment) is still asserted on the
 * source, but now scoped to ONE question: do both call sites actually call
 * the shared, tested function — not a re-implementation of their own.
 */

describe('couponQuoteBasis', () => {
  it('sums price * quantity across loose items', () => {
    expect(
      couponQuoteBasis([
        { price: 1000, quantity: 1 },
        { price: 2500, quantity: 3 },
      ])
    ).toBe(1000 + 2500 * 3);
  });

  it('is quantity-sensitive — the exact regression a source-text grep could not catch', () => {
    // A single line at quantity 4: dropping `* item.quantity` from the
    // implementation (e.g. `sum + item.price`) would return 1500 here
    // instead of 6000, silently undercharging the quoted discount basis
    // for every loose line with quantity > 1.
    expect(couponQuoteBasis([{ price: 1500, quantity: 4 }])).toBe(6000);
  });

  it('is 0 for an empty cart (e.g. a bundle-only cart, once bundles are excluded by the caller)', () => {
    expect(couponQuoteBasis([])).toBe(0);
  });
});

const WEB_SRC = join(__dirname, '..');

function read(relative: string): string {
  return readFileSync(join(WEB_SRC, relative), 'utf8');
}

/** The bodies of every `POST .../coupons/validate` call in a source file. */
function couponValidateCalls(source: string, window = 400): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('coupons/validate', from);
    if (at === -1) break;
    // The request body always lands within the next few lines of the call.
    calls.push(source.slice(at, at + window));
    from = at + 1;
  }
  return calls;
}

describe('coupon quote basis call sites (P0-1 / P2-c)', () => {
  const checkout = read('app/checkout/CheckoutClient.tsx');
  const cart = read('app/cart/CartClient.tsx');

  it('CheckoutClient quotes the coupon against the loose-items subtotal', () => {
    const calls = couponValidateCalls(checkout);
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(call).toContain('orderTotal: couponBasis');
      expect(call).not.toContain('orderTotal: cart.subtotal');
      expect(call).not.toContain('orderTotal: cartContextTotal');
    }
  });

  it('every call also sends the whole loose cart for a free-shipping code (Ruling B2B-M2, final review P2-3)', () => {
    for (const call of [...couponValidateCalls(checkout, 900), ...couponValidateCalls(cart, 900)]) {
      expect(call).toContain('...couponQuoteLooseFields(');
    }
  });

  it('CartClient quotes the coupon against the loose-items subtotal on both paths', () => {
    const calls = couponValidateCalls(cart);
    // Manual apply + the auto-apply of a code stored on /cart.
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toContain('orderTotal: couponBasis');
      expect(call).not.toContain('orderTotal: cartTotal');
    }
  });

  it('both call sites derive couponBasis from the shared couponQuoteBasis, not a re-implementation', () => {
    for (const [name, source, itemsVar] of [
      ['CheckoutClient', checkout, 'cartContextItems'],
      ['CartClient', cart, 'cartItems'],
    ] as const) {
      expect(source, `${name} imports couponQuoteBasis`).toContain(
        "from '@/lib/coupon-quote-basis'"
      );
      expect(source, `${name} calls couponQuoteBasis on the loose items`).toContain(
        `couponQuoteBasis(${itemsVar})`
      );
      // Never a from-scratch reduce over the bundle rows.
      expect(source, `${name} must not sum bundles inline`).not.toMatch(
        /const couponBasis[\s\S]{0,200}\.reduce/
      );
    }
  });

  it('the order summary explains that a coupon skips bundle lines', () => {
    const copy = 'Coupon applies to items outside your bundles';
    // Bilingual, from the translations map — never a hardcoded storefront string.
    expect(read('contexts/LanguageContext.tsx')).toContain(copy);
    // Shown on both summaries, and only when a bundle AND a coupon are present.
    expect(read('app/checkout/OrderSummary.tsx')).toContain('appliedCoupon && bundles.length > 0');
    expect(cart).toContain('promoApplied && cartBundles.length > 0');
  });
});

describe('#1766 — an unavailable (deleted-product) line is not part of the coupon basis', () => {
  it('couponQuoteBasis skips it', () => {
    expect(
      couponQuoteBasis([
        { price: 1000, quantity: 2 },
        { price: 5000, quantity: 1, unavailable: true },
      ])
    ).toBe(2000);
  });

  it('couponQuoteCartItems skips it, so Σ lineTotal still equals the basis', () => {
    const items = [
      { productId: 'a', price: 1000, quantity: 2 },
      { productId: 'gone', price: 5000, quantity: 1, unavailable: true },
    ];
    const lines = couponQuoteCartItems(items);
    expect(lines.map(l => l.productId)).toEqual(['a']);
    expect(lines.reduce((s, l) => s + l.lineTotal, 0)).toBe(couponQuoteBasis(items));
  });
});

/**
 * B2B Ruling B2B-5 (design review I-2): a line priced by a quantity tier or a wholesale group price is excluded from the
 * coupon basis, exactly as `OrderService.create` builds it. Real arithmetic, so the quote equals the charge.
 */
describe('couponQuoteBasis / couponQuoteCartItems exclude tier and group priced lines (display == charge)', () => {
  const tier = { productId: 'p1', price: 8500, quantity: 10, priceSource: 'tier' as const };
  const group = { productId: 'p2', price: 9000, quantity: 2, priceSource: 'group' as const };
  const base = { productId: 'p3', price: 1000, quantity: 3, priceSource: 'base' as const };

  it('an all-tier / group cart has basis 0 and no cart items: a 10% coupon is quoted 0, not 10% of the cart', () => {
    expect(couponQuoteBasis([tier, group])).toBe(0);
    expect(couponQuoteCartItems([tier, group])).toEqual([]);
    expect(Math.round((couponQuoteBasis([tier, group]) * 10) / 100)).toBe(0);
  });

  it('a mixed cart quotes only the base-priced lines: 10% of 3000, not of 88000', () => {
    expect(couponQuoteBasis([tier, base])).toBe(3000);
    expect(couponQuoteCartItems([tier, base])).toEqual([
      { productId: 'p3', quantity: 3, lineTotal: 3000 },
    ]);
    expect(Math.round((couponQuoteBasis([tier, base]) * 10) / 100)).toBe(300);
  });

  it('a minimum-order coupon is judged on the base basis, so an all-tier cart does NOT meet it', () => {
    const minOrder = 5000;
    expect(couponQuoteBasis([tier]) >= minOrder).toBe(false); // 85000 of tier goods, basis 0
    expect(
      couponQuoteBasis([tier, base, { ...base, productId: 'p4', quantity: 2 }]) >= minOrder
    ).toBe(true); // 5000 base
  });

  it('a FREE-SHIPPING code is judged on the whole loose cart (Ruling B2B-M2): an all-tier cart of 85000 meets "free over 5000"', () => {
    const f = couponQuoteLooseFields([
      tier,
      base,
      { ...base, productId: 'gone', unavailable: true },
    ]);
    expect(f.looseOrderTotal).toBe(85_000 + 3_000);
    expect(f.looseCartItems).toEqual([
      { productId: 'p1', quantity: 10, lineTotal: 85_000 },
      { productId: 'p3', quantity: 3, lineTotal: 3_000 },
    ]);
    expect(couponQuoteLooseFields([tier]).looseOrderTotal >= 5000).toBe(true);
  });

  it('a line with no priceSource (older API) or unavailable behaves as before: base / excluded', () => {
    expect(couponQuoteBasis([{ price: 1000, quantity: 2 }])).toBe(2000);
    expect(couponQuoteBasis([{ price: 1000, quantity: 2, unavailable: true }])).toBe(0);
  });
});
