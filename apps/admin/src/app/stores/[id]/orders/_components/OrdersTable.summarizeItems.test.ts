/**
 * The orders LIST row's compact item summary (`summarizeItems`) used to
 * slice+map the raw `OrderLineItem[]` straight from the API, so a bundle
 * box's component rows read as unrelated products — the exact "N unrelated
 * products at odd allocated prices" shape of this defect class, just as a
 * truncated string instead of a full render: a merchant scanning the list
 * saw "1x Dates, 1x Honey +2 more" for an order that was really one
 * "Ramadan Box". Grouped through `groupOrderLinesForDisplay` first, then
 * limited to the first two DISPLAY ROWS — the same "group first, then
 * limit" rule as `ItemsCard.previewRows` (commit `21e074bd`), so a box
 * straddling the cut is never counted as a fraction of itself.
 */
import { describe, it, expect } from 'vitest';
import { summarizeItems } from './OrdersTable';
import type { OrderLineItem } from './types';

const moreLabel = (count: number) => `+${count} more`;

function item(
  overrides: Partial<OrderLineItem> & { id: string; productName: string }
): OrderLineItem {
  return { quantity: 1, ...overrides };
}

describe('summarizeItems', () => {
  it('returns null when there are no items', () => {
    expect(summarizeItems(undefined, moreLabel, 'en')).toBeNull();
    expect(summarizeItems([], moreLabel, 'en')).toBeNull();
  });

  it('is unchanged for an order with no bundle (identity for the pre-bundle shape)', () => {
    const items = [
      item({ id: 'i1', productName: 'Mastic', quantity: 2 }),
      item({ id: 'i2', productName: 'Caraway', quantity: 1 }),
      item({ id: 'i3', productName: 'Sumac', quantity: 3 }),
      item({ id: 'i4', productName: 'Thyme', quantity: 1 }),
    ];
    expect(summarizeItems(items, moreLabel, 'en')).toBe('2x Mastic, 1x Caraway +2 more');
  });

  it('collapses a bundle box into ONE display row named by the bundle, not its components', () => {
    const items: OrderLineItem[] = [
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

    const summary = summarizeItems(items, moreLabel, 'en');

    expect(summary).toBe('1x Ramadan Box');
    expect(summary).not.toContain('Dates');
    expect(summary).not.toContain('Honey');
    expect(summary).not.toContain('Nuts');
  });

  it('renders the Arabic bundle name when the locale is ar', () => {
    const items: OrderLineItem[] = [
      {
        id: 'bi1',
        productName: 'Dates',
        quantity: 1,
        price: 12000,
        bundleGroupId: 'grp-1',
        bundleName: 'Ramadan Box',
        bundleNameAr: 'علبة رمضان',
      },
    ];
    expect(summarizeItems(items, moreLabel, 'ar')).toBe('1x علبة رمضان');
  });

  it('never lets one box\'s components crowd out other order lines in the "+N more" count', () => {
    // 4 loose lines + a 3-component box = 5 DISPLAY ROWS. Slicing the raw
    // array (7 items) would have shown the box's first component as the
    // 5th "item" and reported "+2 more" instead of "+3 more".
    const items: OrderLineItem[] = [
      item({ id: 'l1', productName: 'Loose A' }),
      item({ id: 'l2', productName: 'Loose B' }),
      item({ id: 'l3', productName: 'Loose C' }),
      item({ id: 'l4', productName: 'Loose D' }),
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
        price: 4966,
        bundleGroupId: 'grp-1',
        bundleName: 'Ramadan Box',
      },
      {
        id: 'bi3',
        productName: 'Nuts',
        quantity: 2,
        price: 1655,
        bundleGroupId: 'grp-1',
        bundleName: 'Ramadan Box',
      },
    ];
    // 5 display rows total, first 2 shown, so 3 remain hidden.
    expect(summarizeItems(items, moreLabel, 'en')).toBe('1x Loose A, 1x Loose B +3 more');
  });
});

describe('summarizeItems localized names (O2)', () => {
  it('uses the Arabic product name in ar, falling back to the snapshot name', () => {
    const items = [
      item({ id: 'a', productName: 'Low Tide Ring', productNameAr: 'خاتم المد المنخفض' }),
      item({ id: 'b', productName: 'Sea Pendant', productNameAr: null }),
    ];
    expect(summarizeItems(items, moreLabel, 'ar')).toBe('1x خاتم المد المنخفض, 1x Sea Pendant');
    expect(summarizeItems(items, moreLabel, 'en')).toBe('1x Low Tide Ring, 1x Sea Pendant');
  });
});
