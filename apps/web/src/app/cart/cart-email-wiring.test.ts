/**
 * Cart-recovery email, storefront half (review item 1). CheckoutClient / CartClient need the full
 * provider tree, so the wiring is pinned on source like cart-unavailable-wiring.test.ts. The
 * server behaviour is proven in tests/unit/cart-email-optin.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
const checkout = read('../checkout/CheckoutClient.tsx');
const page = read('page.tsx');
const hydrator = read('CartRestoreHydrator.tsx');
const resolver = read('../../lib/store-resolver.ts');

describe('checkout email opt-in box', () => {
  it('is unticked by default and rendered only when the store can send the reminder', () => {
    expect(checkout).toMatch(/const \[cartEmailOptIn, setCartEmailOptIn\] = useState\(false\)/);
    expect(checkout).toContain('const showCartEmailOptIn = store?.cartEmailOptIn === true;');
    expect(checkout).toContain('{showCartEmailOptIn && (');
  });

  it('carries the agreed Egyptian + English copy (a neutral, gender-free sentence)', () => {
    expect(checkout).toContain("'Email me about my cart'");
    expect(checkout).toContain("'ابعتلي إيميل لو نسيت حاجة في السلة'");
  });

  it('records consent through the public endpoint, only for a valid address, and can withdraw', () => {
    expect(checkout).toContain("'/public/cart/email-optin'");
    expect(checkout).toMatch(/if \(cartEmailOptIn && !isValidEmail\(email\)\) return;/);
    expect(checkout).toMatch(/if \(!cartEmailOptIn && !cartEmailRecorded\.current\) return;/);
  });

  it('the resolver passes the flag through both store payload builders', () => {
    // storeFromBody (domain + slug lookups share it since Ruling RESOLVE-BULLETPROOF-1) and getStoreById.
    expect(resolver.match(/cartEmailOptIn: storeData\.cartEmailOptIn === true/g)).toHaveLength(2);
  });
});

describe('cart restore link landing', () => {
  it('the cart page mounts the hydrator inside Suspense', () => {
    expect(page).toMatch(/<Suspense fallback=\{null\}>\s*<CartRestoreHydrator \/>\s*<\/Suspense>/);
  });

  it('posts the token to the restore endpoint once the cart is ready, then strips the param', () => {
    expect(hydrator).toContain('if (!isReady || ranRef.current) return;');
    expect(hydrator).toContain("params.get('restore')");
    expect(hydrator).toContain("'/public/cart/restore'");
    expect(hydrator).toContain("url.searchParams.delete('restore')");
  });
});
