import { describe, it, expect } from 'vitest';
import { groupOrderLinesForDisplay, type OrderLineBase } from '@force/shared';

interface Line extends OrderLineBase {
  productName: string;
}

const dates: Line = {
  id: 'oi-1',
  productName: 'Dates',
  quantity: 1,
  price: 3724,
  bundleGroupId: 'group-1',
  bundleName: 'Ramadan Box',
  bundleNameAr: 'صندوق رمضان',
};
const honey: Line = {
  id: 'oi-2',
  productName: 'Sidr Honey',
  quantity: 1,
  price: 4966,
  bundleGroupId: 'group-1',
  bundleName: 'Ramadan Box',
  bundleNameAr: 'صندوق رمضان',
};
const nuts: Line = {
  id: 'oi-3',
  productName: 'Mixed Nuts',
  quantity: 2,
  price: 1655,
  bundleGroupId: 'group-1',
  bundleName: 'Ramadan Box',
  bundleNameAr: 'صندوق رمضان',
};
const soap: Line = {
  id: 'oi-4',
  productName: 'Soap',
  quantity: 1,
  price: 2000,
};

describe('groupOrderLinesForDisplay', () => {
  it('collapses every line sharing a bundleGroupId into ONE row', () => {
    const rows = groupOrderLinesForDisplay([dates, honey, nuts]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('bundle');
  });

  it('sums the group to the bundle price, never a per-component share', () => {
    const rows = groupOrderLinesForDisplay([dates, honey, nuts]);
    const bundle = rows[0];
    if (bundle.kind !== 'bundle') throw new Error('expected a bundle row');
    // 3724 + 4966 + (1655*2) = 12000 — the allocation invariant's sum.
    expect(bundle.total).toBe(12000);
    expect(bundle.quantity).toBe(1);
  });

  it('never renders the per-component allocated prices as separate rows', () => {
    const rows = groupOrderLinesForDisplay([dates, honey, nuts]);
    // Only the collapsed bundle row exists — no 'item' rows for the box's
    // own components, so nothing exposes 3724 / 4966 / 3310 individually.
    expect(rows.every(r => r.kind === 'bundle')).toBe(true);
  });

  it('renders the SNAPSHOTTED bundle name, never a re-fetched one', () => {
    // Even if "the live bundle" has since been renamed, the helper only
    // ever reads bundleName off the line itself — it has no bundle-fetching
    // capability at all, so a renamed/deleted bundle can't reach it.
    const rows = groupOrderLinesForDisplay([{ ...dates, bundleName: 'Ramadan Box' }]);
    const bundle = rows[0];
    if (bundle.kind !== 'bundle') throw new Error('expected a bundle row');
    expect(bundle.name).toBe('Ramadan Box');
    expect(bundle.nameAr).toBe('صندوق رمضان');
  });

  it('two boxes of the same bundle (two bundleGroupIds) render as TWO rows', () => {
    const box2Dates: Line = { ...dates, id: 'oi-5', bundleGroupId: 'group-2' };
    const box2Honey: Line = { ...honey, id: 'oi-6', bundleGroupId: 'group-2' };
    const rows = groupOrderLinesForDisplay([dates, honey, nuts, box2Dates, box2Honey]);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.kind === 'bundle')).toBe(true);
  });

  it('passes non-bundle lines through unchanged', () => {
    const rows = groupOrderLinesForDisplay([soap]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'item', item: soap });
  });

  it('mixes bundle groups and loose items, preserving first-appearance order', () => {
    const rows = groupOrderLinesForDisplay([soap, dates, honey, nuts]);
    expect(rows.map(r => r.kind)).toEqual(['item', 'bundle']);
  });
});
