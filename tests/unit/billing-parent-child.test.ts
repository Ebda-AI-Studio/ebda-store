/**
 * Parent / child store billing (R-EBDA-PRICING-6, Ruling EBDA-FUNNEL-18): pure decisions.
 * Only the oldest store is billed; a child is covered only while it is inside the allowance
 * AND the parent is in good standing; every unknown answers "not covered" (fail closed).
 */
import { describe, it, expect } from 'vitest';
import {
  billingParentOf,
  childCoverage,
  isBillableStore,
  sortOwnerStores,
} from '@api/services/billing/billing-parent';

const t = (d: string) => new Date(`2026-10-${d}T10:00:00.000Z`);
const stores = [
  { id: 'c', createdAt: t('03') },
  { id: 'a', createdAt: t('01') },
  { id: 'b', createdAt: t('02') },
];

describe('billing parent', () => {
  it('is the oldest store, whatever order the rows arrive in', () => {
    expect(billingParentOf(stores)).toBe('a');
    expect(sortOwnerStores(stores).map(s => s.id)).toEqual(['a', 'b', 'c']);
  });
  it('breaks a created-at tie by id so the parent is stable', () => {
    const tie = [
      { id: 'z', createdAt: t('01') },
      { id: 'y', createdAt: t('01') },
    ];
    expect(billingParentOf(tie)).toBe('y');
    expect(billingParentOf([...tie].reverse())).toBe('y');
  });
  it('has no parent when the owner has no stores', () => {
    expect(billingParentOf([])).toBeNull();
  });
});

describe('isBillableStore (charge paths)', () => {
  it('only the parent is billable', () => {
    expect(isBillableStore('a', stores)).toBe(true);
    expect(isBillableStore('b', stores)).toBe(false);
    expect(isBillableStore('c', stores)).toBe(false);
  });
  it('fails closed for a store the list does not contain', () => {
    expect(isBillableStore('ghost', stores)).toBe(false);
    expect(isBillableStore('a', [])).toBe(false);
  });
});

describe('childCoverage', () => {
  const ok = { stores, allowance: 3, parentInGoodStanding: true };
  it('covers a child inside the allowance while the parent is in good standing', () => {
    expect(childCoverage({ ...ok, storeId: 'b' })).toEqual({ covered: true, parentId: 'a' });
    expect(childCoverage({ ...ok, storeId: 'c' })).toEqual({ covered: true, parentId: 'a' });
  });
  it('does not cover the parent itself', () => {
    expect(childCoverage({ ...ok, storeId: 'a' })).toEqual({
      covered: false,
      reason: 'not_a_child',
    });
  });
  it('does not cover a child beyond the allowance (rank >= allowance)', () => {
    expect(childCoverage({ ...ok, allowance: 2, storeId: 'c' })).toEqual({
      covered: false,
      reason: 'over_allowance',
    });
    expect(childCoverage({ ...ok, allowance: 1, storeId: 'b' }).covered).toBe(false);
  });
  it('treats an unlimited allowance as open-ended', () => {
    expect(
      childCoverage({ ...ok, allowance: Number.POSITIVE_INFINITY, storeId: 'c' }).covered
    ).toBe(true);
  });
  it('does not cover any child when the parent is not in good standing', () => {
    expect(childCoverage({ ...ok, parentInGoodStanding: false, storeId: 'b' })).toEqual({
      covered: false,
      reason: 'parent_not_in_good_standing',
    });
  });
  it('fails closed: unknown store, no stores, NaN allowance', () => {
    expect(childCoverage({ ...ok, storeId: 'ghost' }).covered).toBe(false);
    expect(childCoverage({ ...ok, stores: [], storeId: 'b' })).toEqual({
      covered: false,
      reason: 'no_parent',
    });
    expect(childCoverage({ ...ok, allowance: Number.NaN, storeId: 'b' }).covered).toBe(false);
  });
});
