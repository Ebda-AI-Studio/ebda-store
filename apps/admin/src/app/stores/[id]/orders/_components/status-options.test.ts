import { describe, it, expect } from 'vitest';
import { statusOptionsFor } from './types';

describe('statusOptionsFor', () => {
  it('offers Refunded on a paid cancelled order (PR #770)', () => {
    expect(statusOptionsFor({ status: 'cancelled', paymentStatus: 'paid' })).toEqual(['refunded']);
  });

  it('never offers Refunded on an unpaid pending or cancelled order', () => {
    expect(statusOptionsFor({ status: 'cancelled', paymentStatus: 'pending' })).toEqual([]);
    expect(statusOptionsFor({ status: 'pending', paymentStatus: 'pending' })).not.toContain(
      'refunded'
    );
    expect(statusOptionsFor({ status: 'pending', paymentStatus: 'pending' })).toContain(
      'cancelled'
    );
  });

  it('leaves the other states unchanged', () => {
    expect(statusOptionsFor({ status: 'delivered', paymentStatus: 'paid' })).toEqual(['refunded']);
    expect(statusOptionsFor({ status: 'refunded', paymentStatus: 'refunded' })).toEqual([]);
  });
});
