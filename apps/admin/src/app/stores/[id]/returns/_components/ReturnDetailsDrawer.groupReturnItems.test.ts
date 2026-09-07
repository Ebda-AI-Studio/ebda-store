/**
 * `ReturnDetailsDrawer` used to list a return's `ReturnItem[]` flat — a
 * returned "Ramadan Box" (atomic, so all 3 components always come back
 * together) read as 3 unrelated returned products with no indication they
 * were one box. `groupReturnItems` groups them under the box's name, joined
 * via the returned line's `orderItem` (`ReturnService.list`/`getById`'s new
 * `items.include.orderItem` select) — mirroring admin `ItemsCard`'s
 * `groupItemsForAdmin`, but over `ReturnItem` (no price/total field).
 */
import { describe, it, expect } from 'vitest';
import { groupReturnItems } from './ReturnDetailsDrawer';
import type { ReturnItem } from './types';

function item(overrides: Partial<ReturnItem> & { id: string; productName: string }): ReturnItem {
  return { quantity: 1, ...overrides };
}

describe('groupReturnItems', () => {
  it('leaves non-bundle lines flat and ungrouped, unchanged (identity for a return with no bundle)', () => {
    const items = [
      item({ id: 'ri1', productName: 'Rug' }),
      item({ id: 'ri2', productName: 'Lamp' }),
    ];
    expect(groupReturnItems(items)).toEqual([
      { kind: 'item', item: items[0] },
      { kind: 'item', item: items[1] },
    ]);
  });

  it('groups every component of an atomic bundle return under the box name', () => {
    const items: ReturnItem[] = [
      {
        id: 'ri1',
        productName: 'Dates',
        quantity: 1,
        orderItem: {
          bundleGroupId: 'grp-1',
          bundleName: 'Ramadan Box',
          bundleNameAr: 'علبة رمضان',
        },
      },
      {
        id: 'ri2',
        productName: 'Honey',
        quantity: 1,
        orderItem: {
          bundleGroupId: 'grp-1',
          bundleName: 'Ramadan Box',
          bundleNameAr: 'علبة رمضان',
        },
      },
      {
        id: 'ri3',
        productName: 'Nuts',
        quantity: 2,
        orderItem: {
          bundleGroupId: 'grp-1',
          bundleName: 'Ramadan Box',
          bundleNameAr: 'علبة رمضان',
        },
      },
    ];

    const entries = groupReturnItems(items);
    expect(entries).toHaveLength(1);
    const group = entries[0];
    if (group.kind !== 'group') throw new Error('expected a group entry');
    expect(group.name).toBe('Ramadan Box');
    expect(group.nameAr).toBe('علبة رمضان');
    // Every component present — atomic returns never split a box.
    expect(group.items).toEqual(items);
    expect(group.items.map(i => i.productName)).toEqual(['Dates', 'Honey', 'Nuts']);
  });

  it('interleaves a loose return line between two bundle groups correctly', () => {
    const items: ReturnItem[] = [
      item({ id: 'loose-1', productName: 'Rug' }),
      item({
        id: 'bi1',
        productName: 'Dates',
        orderItem: { bundleGroupId: 'grp-1', bundleName: 'Box A', bundleNameAr: null },
      }),
      item({
        id: 'bi2',
        productName: 'Honey',
        orderItem: { bundleGroupId: 'grp-1', bundleName: 'Box A', bundleNameAr: null },
      }),
    ];
    const entries = groupReturnItems(items);
    expect(entries.map(e => e.kind)).toEqual(['item', 'group']);
  });

  it('falls back to "Bundle" when bundleName is missing', () => {
    const items: ReturnItem[] = [
      item({
        id: 'bi1',
        productName: 'Widget',
        orderItem: { bundleGroupId: 'grp-1', bundleName: null, bundleNameAr: null },
      }),
    ];
    const entries = groupReturnItems(items);
    const group = entries[0];
    if (group.kind !== 'group') throw new Error('expected a group entry');
    expect(group.name).toBe('Bundle');
  });
});
