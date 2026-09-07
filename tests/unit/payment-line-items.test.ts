/**
 * I3 (final review) — the payment gateway's hosted page must not show the
 * customer per-component allocated prices for a bundle.
 *
 * `payment.routes.ts` /create, `order.routes.ts` payment-link and
 * `payment.factory.ts` retry all build a provider `PaymentItem[]` from raw
 * `order.items`. Every OTHER customer surface already collapses a bundle's
 * component lines through `groupOrderLinesForDisplay`; `buildPaymentLineItems`
 * is the same collapse applied to the one surface that was missed.
 *
 * The one property that must never break here: totals reconcile EXACTLY to
 * what the provider is charging — Σ(unitPrice × quantity) across the built
 * items must equal Σ(price × quantity) across the raw order lines, with or
 * without a bundle in the order.
 */
import { describe, it, expect } from 'vitest';
import { buildPaymentLineItems, type PaymentLineItemSource } from '@api/lib/payment-line-items';

function rawTotal(items: readonly PaymentLineItemSource[]): number {
  return items.reduce((sum, i) => sum + i.price * i.quantity, 0);
}

function builtTotal(items: ReturnType<typeof buildPaymentLineItems>): number {
  return items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
}

describe('buildPaymentLineItems', () => {
  it('passes loose (non-bundle) lines through unchanged', () => {
    const items: PaymentLineItemSource[] = [
      { id: 'i1', productName: 'Rug', quantity: 2, price: 5000, sku: 'RUG-1' },
      { id: 'i2', productName: 'Lamp', quantity: 1, price: 3000, sku: null },
    ];
    const result = buildPaymentLineItems(items);
    expect(result).toEqual([
      { name: 'Rug', quantity: 2, unitPrice: 5000, sku: 'RUG-1' },
      { name: 'Lamp', quantity: 1, unitPrice: 3000, sku: undefined },
    ]);
  });

  it('collapses a bundle group into ONE line named by the bundle — never the components', () => {
    const items: PaymentLineItemSource[] = [
      {
        id: 'bi1',
        productName: 'Dates',
        quantity: 1,
        price: 3724,
        bundleGroupId: 'grp-1',
        bundleName: 'Ramadan Box',
        bundleNameAr: 'علبة رمضان',
      },
      {
        id: 'bi2',
        productName: 'Honey',
        quantity: 1,
        price: 4966,
        bundleGroupId: 'grp-1',
        bundleName: 'Ramadan Box',
        bundleNameAr: 'علبة رمضان',
      },
      {
        id: 'bi3',
        productName: 'Nuts',
        quantity: 2,
        price: 1655,
        bundleGroupId: 'grp-1',
        bundleName: 'Ramadan Box',
        bundleNameAr: 'علبة رمضان',
      },
    ];
    const result = buildPaymentLineItems(items);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Ramadan Box');
    expect(result[0].quantity).toBe(1);
    // 3724 + 4966 + (1655*2) = 12000
    expect(result[0].unitPrice).toBe(12000);

    // The one property that must never break: totals reconcile exactly.
    expect(builtTotal(result)).toBe(rawTotal(items));

    // No per-component name or allocated price anywhere in the built payload.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Dates');
    expect(serialized).not.toContain('Honey');
    expect(serialized).not.toContain('Nuts');
    expect(serialized).not.toContain('3724');
    expect(serialized).not.toContain('4966');
    expect(serialized).not.toContain('1655');
  });

  it('emits one row PER BOX for two boxes of the same bundle, each reconciling to the per-box price', () => {
    const box = (group: string): PaymentLineItemSource[] => [
      {
        id: `${group}-a`,
        productName: 'Dates',
        quantity: 1,
        price: 6000,
        bundleGroupId: group,
        bundleName: 'Ramadan Box',
      },
    ];
    const items = [...box('grp-1'), ...box('grp-2')];
    const result = buildPaymentLineItems(items);

    expect(result).toHaveLength(2);
    expect(result.every(r => r.name === 'Ramadan Box' && r.quantity === 1)).toBe(true);
    expect(builtTotal(result)).toBe(rawTotal(items));
  });

  it('reconciles exactly for a MIXED cart (loose item + bundle)', () => {
    const items: PaymentLineItemSource[] = [
      { id: 'i1', productName: 'Rug', quantity: 1, price: 8000 },
      {
        id: 'bi1',
        productName: 'Dates',
        quantity: 1,
        price: 3724,
        bundleGroupId: 'grp-1',
        bundleName: 'Ramadan Box',
      },
      {
        id: 'bi2',
        productName: 'Honey',
        quantity: 1,
        price: 8276,
        bundleGroupId: 'grp-1',
        bundleName: 'Ramadan Box',
      },
    ];
    const result = buildPaymentLineItems(items);
    expect(result).toHaveLength(2); // one loose line + one collapsed bundle row
    expect(builtTotal(result)).toBe(rawTotal(items));
  });

  it('falls back to "Bundle" when bundleName is missing, without dropping the sku field shape', () => {
    const items: PaymentLineItemSource[] = [
      { id: 'bi1', productName: 'Widget', quantity: 1, price: 1000, bundleGroupId: 'grp-1' },
    ];
    const result = buildPaymentLineItems(items);
    expect(result[0].name).toBe('Bundle');
    expect(result[0]).not.toHaveProperty('componentSum');
  });
});
