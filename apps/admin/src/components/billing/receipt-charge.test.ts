import { describe, it, expect } from 'vitest';
import { pickReceiptCharge } from './receipt-charge';

const c = (id: string, status: string, type = 'checkout') => ({ id, status, type }) as never;

describe('pickReceiptCharge', () => {
  const charges = [c('old', 'succeeded', 'renewal'), c('new', 'pending')];
  it('right after paying, shows NOTHING until THIS charge is succeeded (never the previous receipt)', () => {
    expect(pickReceiptCharge(charges, { returnChargeId: 'new', openedId: null })).toEqual({
      charge: null,
      processing: true,
    });
  });
  it('shows this charge once it is succeeded', () => {
    const done = [c('old', 'succeeded', 'renewal'), c('new', 'succeeded')];
    expect(pickReceiptCharge(done, { returnChargeId: 'new', openedId: null })).toEqual({
      charge: done[1],
      processing: false,
    });
  });
  it('a manually opened receipt wins and never shows refunds or unpaid charges', () => {
    expect(pickReceiptCharge(charges, { returnChargeId: null, openedId: 'old' }).charge).toBe(
      charges[0]
    );
    expect(pickReceiptCharge(charges, { returnChargeId: null, openedId: 'new' }).charge).toBeNull();
    expect(
      pickReceiptCharge([c('r', 'succeeded', 'refund')], { returnChargeId: null, openedId: 'r' })
        .charge
    ).toBeNull();
  });
  it('no return and nothing opened: nothing', () => {
    expect(pickReceiptCharge(charges, { returnChargeId: null, openedId: null })).toEqual({
      charge: null,
      processing: false,
    });
  });
});
