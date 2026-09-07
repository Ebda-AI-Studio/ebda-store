/**
 * I6 (final review): the admin order screen must GROUP a bundle's expanded
 * component lines under the bundle's name — but, unlike the storefront's
 * customer-facing collapse, keep every component line individually visible
 * (the merchant fulfilling the order needs to know what to physically put
 * in the box). `groupItemsForAdmin` is the pure grouping logic behind
 * `ItemsCard`; this file exercises it directly without rendering JSX.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupItemsForAdmin, previewRows } from './ItemsCard';
import type { OrderItemDetail } from './types';

function item(overrides: Partial<OrderItemDetail> & { id: string }): OrderItemDetail {
  return {
    productId: 'p1',
    productName: 'Product',
    variantName: null,
    sku: null,
    quantity: 1,
    price: 1000,
    total: 1000,
    ...overrides,
  };
}

describe('groupItemsForAdmin', () => {
  it('leaves loose (non-bundle) lines exactly as they were, unchanged and ungrouped', () => {
    const items = [item({ id: 'i1' }), item({ id: 'i2' })];
    const entries = groupItemsForAdmin(items);
    expect(entries).toEqual([
      { kind: 'item', item: items[0] },
      { kind: 'item', item: items[1] },
    ]);
  });

  it('groups a bundle box under its name WITHOUT collapsing the component lines', () => {
    const items = [
      item({
        id: 'bi1',
        productName: 'Dates',
        price: 3724,
        total: 3724,
        bundleGroupId: 'grp-1',
        bundleName: 'Ramadan Box',
        bundleNameAr: 'علبة رمضان',
      }),
      item({
        id: 'bi2',
        productName: 'Honey',
        price: 4966,
        total: 4966,
        bundleGroupId: 'grp-1',
        bundleName: 'Ramadan Box',
        bundleNameAr: 'علبة رمضان',
      }),
      item({
        id: 'bi3',
        productName: 'Nuts',
        quantity: 2,
        price: 1655,
        total: 3310,
        bundleGroupId: 'grp-1',
        bundleName: 'Ramadan Box',
        bundleNameAr: 'علبة رمضان',
      }),
    ];
    const entries = groupItemsForAdmin(items);

    expect(entries).toHaveLength(1);
    const group = entries[0];
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('unreachable');
    expect(group.name).toBe('Ramadan Box');
    expect(group.nameAr).toBe('علبة رمضان');
    // ALL THREE component lines survive, individually, in order — this is
    // grouping and labelling, never the customer-facing collapse.
    expect(group.items).toEqual(items);
    expect(group.items.map(i => i.productName)).toEqual(['Dates', 'Honey', 'Nuts']);
  });

  it('writes one group PER BOX for two boxes of the same bundle, not one merged group', () => {
    const box = (group: string): OrderItemDetail => ({
      id: `${group}-a`,
      productId: 'p1',
      productName: 'Dates',
      variantName: null,
      sku: null,
      quantity: 1,
      price: 6000,
      total: 6000,
      bundleGroupId: group,
      bundleName: 'Ramadan Box',
    });
    const items = [box('grp-1'), box('grp-2')];
    const entries = groupItemsForAdmin(items);

    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.kind === 'group')).toBe(true);
  });

  it('interleaves a loose item between two bundle groups correctly, in original order', () => {
    const items = [
      item({ id: 'loose-1' }),
      item({ id: 'bi1', bundleGroupId: 'grp-1', bundleName: 'Box A' }),
      item({ id: 'bi2', bundleGroupId: 'grp-1', bundleName: 'Box A' }),
      item({ id: 'loose-2' }),
      item({ id: 'bi3', bundleGroupId: 'grp-2', bundleName: 'Box B' }),
    ];
    const entries = groupItemsForAdmin(items);
    expect(entries.map(e => e.kind)).toEqual(['item', 'group', 'item', 'group']);
  });

  it('falls back to "Bundle" when bundleName is missing', () => {
    const items = [item({ id: 'bi1', bundleGroupId: 'grp-1' })];
    const entries = groupItemsForAdmin(items);
    const group = entries[0];
    if (group.kind !== 'group') throw new Error('unreachable');
    expect(group.name).toBe('Bundle');
  });
});

/**
 * P1-2 (final review): `ItemsCard` sliced `items` to `previewLimit` and only
 * then grouped, so a box straddling the preview cut rendered as a FRACTION
 * of itself — the merchant read "Ramadan Box · 3.724 KWD" for a box the
 * customer paid 12.000 for — and "+N more" counted component lines rather
 * than display rows. `previewRows` groups first and limits by display rows.
 */
describe('previewRows — the preview cut is taken in display rows', () => {
  const box = (id: string, total: number) =>
    item({
      id,
      total,
      price: total,
      bundleGroupId: 'grp-1',
      bundleName: 'Ramadan Box',
      bundleNameAr: 'علبة رمضان',
    });

  // The report's exact state: 4 loose lines followed by a 3-component box,
  // allocated 3724 / 4966 / 3310 = 12000, previewLimit 5.
  const FOUR_LOOSE_PLUS_A_BOX = [
    item({ id: 'l1' }),
    item({ id: 'l2' }),
    item({ id: 'l3' }),
    item({ id: 'l4' }),
    box('b1', 3724),
    box('b2', 4966),
    box('b3', 3310),
  ];

  it('renders the box at its FULL total even when it straddles the preview cut', () => {
    const { entries } = previewRows(FOUR_LOOSE_PLUS_A_BOX, 5, false);

    const group = entries.find(e => e.kind === 'group');
    if (!group || group.kind !== 'group') throw new Error('the box must render as one group');
    // Every component of the box is present, so BundleGroupRow's
    // `items.reduce((s, i) => s + i.total, 0)` is the price the customer paid.
    expect(group.items).toHaveLength(3);
    expect(group.items.reduce((sum, i) => sum + i.total, 0)).toBe(12000);
  });

  it('counts hidden entries in display rows, not component lines', () => {
    // 5 display rows in total (4 loose + 1 box) — all of them fit in a
    // limit of 5, so nothing is hidden. Slicing the raw items would have
    // reported "+2 more" for the rest of one box.
    const { totalRows, hiddenRows } = previewRows(FOUR_LOOSE_PLUS_A_BOX, 5, false);
    expect(totalRows).toBe(5);
    expect(hiddenRows).toBe(0);
  });

  it('hides whole rows past the limit and never a partial box', () => {
    const { entries, totalRows, hiddenRows } = previewRows(FOUR_LOOSE_PLUS_A_BOX, 3, false);
    expect(entries).toHaveLength(3);
    expect(entries.every(e => e.kind === 'item')).toBe(true);
    expect(totalRows).toBe(5);
    expect(hiddenRows).toBe(2);
  });

  it('shows everything when expanded', () => {
    const { entries, hiddenRows } = previewRows(FOUR_LOOSE_PLUS_A_BOX, 3, true);
    expect(entries).toHaveLength(5);
    expect(hiddenRows).toBe(0);
  });

  it('is the identity for an order with no bundle (one item = one row)', () => {
    const items = [item({ id: 'l1' }), item({ id: 'l2' }), item({ id: 'l3' })];
    const { entries, totalRows, hiddenRows } = previewRows(items, 2, false);
    expect(entries).toEqual([
      { kind: 'item', item: items[0] },
      { kind: 'item', item: items[1] },
    ]);
    expect(totalRows).toBe(3);
    expect(hiddenRows).toBe(1);
  });
});

/**
 * P2-g (scoped re-review): P1-2 fixed `previewRows`/the "View all (N)"
 * button to count DISPLAY ROWS — one bundle box is one row, however many
 * components it has — but left the header's `itemCount` counting
 * `items.length` (component lines), so a 4-loose+3-component order showed
 * "7 items" directly above a "View all (5)" button.
 *
 * There is no DOM harness in this repo (see `apps/web/src/lib/
 * bundles-nav.ts`'s doc comment for the same rationale) to render
 * `ItemsCard` and read the header text, so — like `bundles-nav.test.ts`'s
 * ShopChrome check — this asserts on the component SOURCE: the header must
 * be wired to the same `totalRows` the button already uses, never back to
 * `items.length`.
 */
describe('ItemsCard header count agrees with the "View all" button (P2-g)', () => {
  const source = readFileSync(join(__dirname, 'ItemsCard.tsx'), 'utf8');

  it('the itemCount header is wired to totalRows, not items.length', () => {
    expect(source).toContain("t('itemCount', { count: totalRows })");
    expect(source).not.toContain("t('itemCount', { count: items.length })");
  });
});
