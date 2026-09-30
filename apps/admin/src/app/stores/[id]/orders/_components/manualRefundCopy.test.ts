import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import ar from '@/i18n/messages/ar.json';
import { manualRefundDescriptionKey } from './manualRefundCopy';

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
    expect(text).not.toMatch(/tells the customer a refund was issued/);
  });
});
