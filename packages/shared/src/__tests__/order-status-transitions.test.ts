import { describe, it, expect } from 'vitest';
import { ORDER_STATUS_TRANSITIONS, orderStatusOptions } from '../order-status-transitions';

describe('orderStatusOptions', () => {
  it('offers Refunded on a paid cancelled order (PR #770)', () => {
    expect(orderStatusOptions({ status: 'cancelled', paymentStatus: 'paid' })).toEqual([
      'refunded',
    ]);
  });

  it('never offers Refunded on an unpaid pending or cancelled order', () => {
    expect(orderStatusOptions({ status: 'cancelled', paymentStatus: 'unpaid' })).toEqual([]);
    expect(orderStatusOptions({ status: 'pending', paymentStatus: 'unpaid' })).toEqual([
      'confirmed',
      'processing',
      'shipped',
      'delivered',
      'cancelled',
    ]);
  });

  it('offers Refunded from confirmed, processing and shipped (the stale PWA copy did not)', () => {
    for (const status of ['confirmed', 'processing', 'shipped', 'delivered']) {
      expect(orderStatusOptions({ status, paymentStatus: 'paid' })).toContain('refunded');
    }
  });

  it('returns a copy, so a caller cannot mutate the shared map', () => {
    const opts = orderStatusOptions({ status: 'delivered', paymentStatus: 'paid' });
    opts.push('pending');
    expect(ORDER_STATUS_TRANSITIONS.delivered).toEqual(['refunded']);
  });

  it('treats an unknown status as having no options', () => {
    expect(orderStatusOptions({ status: 'bogus', paymentStatus: 'paid' })).toEqual([]);
  });
});

describe('InstaPay awaiting-confirmation status (SP6a)', () => {
  it('opens only confirmed and cancelled: it can never ship from here', () => {
    expect(ORDER_STATUS_TRANSITIONS.awaiting_payment_confirmation).toEqual([
      'confirmed',
      'cancelled',
    ]);
    for (const to of ['processing', 'shipped', 'delivered', 'refunded']) {
      expect(ORDER_STATUS_TRANSITIONS.awaiting_payment_confirmation).not.toContain(to);
    }
  });

  it('the status picker never offers confirmed: that needs the payment-received action', () => {
    expect(
      orderStatusOptions({ status: 'awaiting_payment_confirmation', paymentStatus: 'unpaid' })
    ).toEqual(['cancelled']);
  });
});
