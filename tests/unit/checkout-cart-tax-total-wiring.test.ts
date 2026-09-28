/**
 * The checkout/cart `total` a shopper sees must include VAT when it's
 * levied on top of the price, and must NOT double-count it when it's
 * already baked into the listed price (ruling M3-6, docs/RULINGS.md — the
 * scoped-audit P1 follow-up that made order creation honour the same flag,
 * extracting rather than adding when the price already includes tax).
 *
 * That branch lives in a plain arithmetic expression inside CheckoutClient
 * and CartClient, not behind any prop the render tests
 * (checkout-order-summary-tax-render.test.tsx,
 * apps/web/src/templates/shared/order-summary-tax-render.test.tsx) can
 * reach — those only prove the LABEL/amount the OrderSummary component is
 * GIVEN renders correctly, not that the caller computed `total` correctly
 * upstream. Asserted on the source, same reasoning as
 * checkout-error-alert-renders.test.tsx: no DOM environment in this repo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const R = join(__dirname, '../..');
const checkoutClient = readFileSync(
  join(R, 'apps/web/src/app/checkout/CheckoutClient.tsx'),
  'utf8'
);
const cartClient = readFileSync(join(R, 'apps/web/src/app/cart/CartClient.tsx'), 'utf8');

describe('CheckoutClient — tax computed via the shared formula, excluded from total when included in price', () => {
  it('imports computeOrderTax from @force/shared, not a private mirror', () => {
    expect(checkoutClient).toMatch(
      /import\s*\{[^}]*computeOrderTax[^}]*\}\s*from\s*'@force\/shared'/
    );
  });

  it('computes tax the same way order creation does: subtotal, discount, rate/100, and the includedInPrice flag', () => {
    expect(checkoutClient).toMatch(
      /computeOrderTax\(subtotal, discount, taxRatePercent \/ 100, taxIncludedInPrice\)/
    );
  });

  it('adds tax to total only when NOT already included in the price', () => {
    expect(checkoutClient).toMatch(/taxIncludedInPrice \? 0 : tax/);
  });
});

describe('CartClient — same formula, same exclusion', () => {
  it('imports computeOrderTax from @force/shared', () => {
    expect(cartClient).toMatch(/import\s*\{[^}]*computeOrderTax[^}]*\}\s*from\s*'@force\/shared'/);
  });

  it('computes tax the same way order creation does, passing the includedInPrice flag', () => {
    expect(cartClient).toMatch(
      /computeOrderTax\(subtotal, discount, taxRatePercent \/ 100, taxIncludedInPrice\)/
    );
  });

  it('adds tax to total only when NOT already included in the price', () => {
    expect(cartClient).toMatch(/taxIncludedInPrice \? 0 : tax/);
  });
});

describe('order.service.ts — the charge honours the SAME includedInPrice flag (P1 fix)', () => {
  const orderService = readFileSync(join(R, 'apps/api/src/services/order.service.ts'), 'utf8');

  it('resolves the flag via resolveActiveTaxRate (gated — see order-tax.ts / ruling M3-9)', () => {
    const occurrences = orderService.match(/resolveActiveTaxRate\(storeId\)/g) ?? [];
    expect(occurrences.length).toBe(2); // storefront checkout + the admin manual-order path
  });

  it('passes includedInPrice into computeOrderTax at both call sites', () => {
    const occurrences =
      orderService.match(/computeOrderTax\([^)]*activeTax\.includedInPrice\)/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it('excludes tax from total at both call sites when the price already includes it', () => {
    const occurrences = orderService.match(/activeTax\.includedInPrice \? 0 : tax/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});

/**
 * CartClient's FALLBACK price breakdown (rendered while `useTemplateComponents`
 * is still `null` — the SSR/first-paint state on every cart mount, and the
 * permanent state if the theme chunk fails to load — scoped-audit P2
 * follow-up: it had a Subtotal/Discount/Shipping/Total breakdown and no VAT
 * row at all, even though `total` already included tax).
 *
 * This block is ~1000 lines into a component with a couple dozen hooks
 * (useCart, useStore, useFeatures, useTemplateComponents, effects that fetch
 * shipping zones…) — asserted on the source rather than rendered, for the
 * same reason M3-4 gives (docs/RULINGS.md): no DOM environment in this repo,
 * and mocking every one of those hooks just to reach one JSX block would be
 * far more brittle than reading the block itself. The other 6 render paths
 * (checkout OrderSummary + all 5 themed cart summaries) ARE small enough to
 * render for real — see checkout-order-summary-tax-render.test.tsx and
 * apps/web/src/templates/shared/order-summary-tax-render.test.tsx.
 */
describe('CartClient fallback summary — the 7th (previously untested) render path', () => {
  it('computes its own taxLabel via the shared formatTaxRowLabel', () => {
    expect(cartClient).toMatch(
      /import\s*\{\s*formatTaxRowLabel\s*\}\s*from\s*'\.\.\/\.\.\/lib\/tax-display'/
    );
    expect(cartClient).toMatch(
      /const taxLabel = formatTaxRowLabel\(\s*tax,\s*taxRatePercent,\s*taxIncludedInPrice,\s*language === 'ar',\s*localize\s*\);/
    );
  });

  it('renders the exclusive row (gated on tax > 0 && !taxIncludedInPrice) BEFORE the Total row', () => {
    const exclusiveGateAt = cartClient.search(/\{tax > 0 && taxLabel && !taxIncludedInPrice && \(/);
    const totalRowAt = cartClient.indexOf(
      "{t('Total', '\\u0627\\u0644\\u0625\\u062c\\u0645\\u0627\\u0644\\u064a')}"
    );
    expect(exclusiveGateAt).toBeGreaterThan(-1);
    expect(totalRowAt).toBeGreaterThan(-1);
    expect(exclusiveGateAt).toBeLessThan(totalRowAt);
  });

  it('renders the inclusive caption (gated on tax > 0 && taxIncludedInPrice) AFTER the Total row', () => {
    const totalRowAt = cartClient.indexOf(
      "{t('Total', '\\u0627\\u0644\\u0625\\u062c\\u0645\\u0627\\u0644\\u064a')}"
    );
    const inclusiveGateAt = cartClient.search(/\{tax > 0 && taxLabel && taxIncludedInPrice && \(/);
    expect(inclusiveGateAt).toBeGreaterThan(-1);
    expect(inclusiveGateAt).toBeGreaterThan(totalRowAt);
  });

  it('the inclusive caption combines label + amount in ONE text node, not a second justify-between row', () => {
    const inclusiveBlock = cartClient.slice(
      cartClient.search(/\{tax > 0 && taxLabel && taxIncludedInPrice && \(/),
      cartClient.search(/\{tax > 0 && taxLabel && taxIncludedInPrice && \(/) + 300
    );
    expect(inclusiveBlock).toMatch(/\{taxLabel\}\s*\{'\\u2014'\}\s*\{formatPrice\(tax\)\}/);
    // Not a two-column row like Subtotal/Shipping/Total (no separate
    // right-aligned `tabular-nums` amount span for this block).
    expect(inclusiveBlock).not.toMatch(/justify-between/);
  });
});
