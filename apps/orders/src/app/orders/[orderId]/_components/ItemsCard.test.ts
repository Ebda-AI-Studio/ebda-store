/**
 * The fulfilment app (orders.ebda.app) reads the same order-detail
 * endpoint admin reads, so a bundle box arrives as N `OrderItem` rows
 * sharing one `bundleGroupId`. Before this fix `ItemsCard` rendered them
 * flat — a fulfiller saw "Ramadan Box" as three unrelated products at
 * allocated prices (3.724 / 4.966 / 3.310) instead of one 12.000 box.
 *
 * `groupItemsForFulfilment`/`previewRows` are the pure grouping logic
 * behind `ItemsCard`; this file exercises them directly without rendering
 * JSX (the root vitest config runs in a `node` environment, no DOM).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupItemsForFulfilment, previewRows, bundleDisplayName } from './ItemsCard';
import type { OrderLineItem } from '@/lib/orders';

function item(overrides: Partial<OrderLineItem> & { id: string }): OrderLineItem {
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

describe('groupItemsForFulfilment', () => {
  it('leaves loose (non-bundle) lines exactly as they were, unchanged and ungrouped', () => {
    const items = [item({ id: 'i1' }), item({ id: 'i2' })];
    const entries = groupItemsForFulfilment(items);
    expect(entries.map(e => e.kind)).toEqual(['item', 'item']);
    expect(entries.map(e => (e.kind === 'item' ? e.item.id : null))).toEqual(['i1', 'i2']);
  });

  it('groups a 3-component bundle box into ONE row labelled with the bundle name, at its summed total, with the three components attached', () => {
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
    const entries = groupItemsForFulfilment(items);

    expect(entries).toHaveLength(1);
    const group = entries[0];
    expect(group.kind).toBe('bundle');
    if (group.kind !== 'bundle') throw new Error('unreachable');
    expect(group.name).toBe('Ramadan Box');
    expect(group.nameAr).toBe('علبة رمضان');
    // The bundle's total is the SUM of the component totals — what the
    // customer paid — never a single component's allocated share.
    expect(group.total).toBe(12000);
    // All three component lines survive, individually, in order, so the
    // fulfiller knows exactly what to physically put in the box.
    expect(group.lines.map(i => i.productName)).toEqual(['Dates', 'Honey', 'Nuts']);
  });

  it('renders a mixed order — loose lines AND a bundle — correctly (both row kinds present, in order)', () => {
    const items = [
      item({ id: 'loose-1', productName: 'Standalone' }),
      item({ id: 'bi1', bundleGroupId: 'grp-1', bundleName: 'Box A', price: 6000, total: 6000 }),
      item({ id: 'bi2', bundleGroupId: 'grp-1', bundleName: 'Box A', price: 6000, total: 6000 }),
      item({ id: 'loose-2', productName: 'Another standalone' }),
    ];
    const entries = groupItemsForFulfilment(items);
    expect(entries.map(e => e.kind)).toEqual(['item', 'bundle', 'item']);
    const bundle = entries[1];
    if (bundle.kind !== 'bundle') throw new Error('unreachable');
    expect(bundle.total).toBe(12000);
    expect(bundle.lines).toHaveLength(2);
  });

  it('writes one group PER BOX for two boxes of the same bundle, not one merged group', () => {
    const box = (group: string): OrderLineItem => ({
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
    const entries = groupItemsForFulfilment(items);

    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.kind === 'bundle')).toBe(true);
  });
});

/**
 * The preview cut is taken in DISPLAY ROWS — group first, then limit — the
 * same fix admin's `ItemsCard` landed in commit `21e074bd` (P1-2 in the
 * final review): slicing raw items before grouping renders a box straddling
 * the cut as a FRACTION of itself.
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

  // 4 loose lines followed by a 3-component box, allocated
  // 3724 / 4966 / 3310 = 12000, previewLimit 5.
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

    const bundle = entries.find(e => e.kind === 'bundle');
    if (!bundle || bundle.kind !== 'bundle') throw new Error('the box must render as one row');
    expect(bundle.lines).toHaveLength(3);
    expect(bundle.total).toBe(12000);
  });

  it('counts hidden entries in display rows, not component lines', () => {
    // 5 display rows in total (4 loose + 1 box) — all fit in a limit of 5,
    // so nothing is hidden. Slicing the raw items would have reported
    // "+2 more" for the rest of the box's components.
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

  it('is the identity for an order with no bundle (one item = one row) — the additive contract', () => {
    const items = [item({ id: 'l1' }), item({ id: 'l2' }), item({ id: 'l3' })];
    const { entries, totalRows, hiddenRows } = previewRows(items, 2, false);
    expect(entries.map(e => (e.kind === 'item' ? e.item.id : null))).toEqual(['l1', 'l2']);
    expect(totalRows).toBe(3);
    expect(hiddenRows).toBe(1);
  });
});

describe('bundleDisplayName — Arabic locale renders bundleNameAr', () => {
  const entry = { name: 'Ramadan Box', nameAr: 'علبة رمضان' };

  it('renders the Arabic snapshot in the ar locale', () => {
    expect(bundleDisplayName(entry, 'ar')).toBe('علبة رمضان');
  });

  it('renders the English snapshot in the en locale', () => {
    expect(bundleDisplayName(entry, 'en')).toBe('Ramadan Box');
  });

  it('falls back to the English snapshot in ar when no Arabic name was captured', () => {
    expect(bundleDisplayName({ name: 'Ramadan Box', nameAr: null }, 'ar')).toBe('Ramadan Box');
  });
});

/**
 * #1566 — the header count must be display rows, like the admin twin (P2-g).
 * The root vitest config has no DOM, so — like the admin ItemsCard test —
 * this asserts on the component source.
 */
describe('ItemsCard header count agrees with the "View all" button', () => {
  const source = readFileSync(join(__dirname, 'ItemsCard.tsx'), 'utf8');

  it('the itemCount header is wired to totalRows, not items.length', () => {
    expect(source).toContain('fmt(t.detail.itemCount, { count: totalRows })');
    expect(source).not.toContain('fmt(t.detail.itemCount, { count: items.length })');
  });
});
