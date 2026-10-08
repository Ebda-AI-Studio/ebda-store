import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import ar from '@/i18n/messages/ar.json';
import { manualRefundBody, manualRefundDescriptionKey } from './manualRefundCopy';

describe('manual refund confirm copy follows the order status (issue 2140)', () => {
  it('a cancelled order gets the copy that promises no second reversal or notice', () => {
    expect(manualRefundDescriptionKey('cancelled')).toBe('manualRefundDescriptionCancelled');
  });
  it.each(['delivered', 'confirmed', 'shipped', undefined])('%s keeps the fan-out copy', s => {
    expect(manualRefundDescriptionKey(s)).toBe('manualRefundDescription');
  });
  it('the cancelled copy exists in both locales and does not promise the fan-out', () => {
    for (const cat of [en, ar] as unknown as {
      orders: { list: { confirm: Record<string, string> } };
    }[]) {
      expect(cat.orders.list.confirm.manualRefundDescriptionCancelled).toBeTruthy();
    }
    const text = (en as unknown as { orders: { list: { confirm: Record<string, string> } } }).orders
      .list.confirm.manualRefundDescriptionCancelled;
    // The fan-out (stock/coupon/loyalty) already ran at cancellation, so this copy must not
    // promise it again — only that the customer is told the refund was issued.
    expect(text).not.toMatch(/It restores stock/);
    expect(text).toMatch(/told their refund was issued/);
  });
  it('both descriptions say to confirm only after the money was given back, and that none is sent', () => {
    for (const cat of [en, ar] as unknown as {
      orders: { list: { confirm: Record<string, string> } };
    }[]) {
      for (const k of ['manualRefundDescription', 'manualRefundDescriptionCancelled']) {
        expect(cat.orders.list.confirm[k]).toBeTruthy();
      }
    }
    const confirm = (en as unknown as { orders: { list: { confirm: Record<string, string> } } })
      .orders.list.confirm;
    for (const k of ['manualRefundDescription', 'manualRefundDescriptionCancelled']) {
      expect(confirm[k]).toMatch(/only after you have already given the customer their money back/);
      expect(confirm[k]).toMatch(/does not send any money/);
    }
  });

  it('manualRefundBody attests the refund is recorded and drops an empty reference', () => {
    expect(manualRefundBody({ method: 'bank_transfer', reference: '   ' })).toEqual({
      status: 'refunded',
      refundRecorded: true,
      refundMethod: 'bank_transfer',
    });
    expect(manualRefundBody({ method: 'cash', reference: ' R-1 ' })).toMatchObject({
      refundReference: 'R-1',
    });
  });
});
