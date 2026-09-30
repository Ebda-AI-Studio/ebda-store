/**
 * Issue 1948: the cancellation notice is accurate by case (ruling R2-5a).
 * Never captured → "You were not charged."; captured, refund pending →
 * "Your refund is being processed." Both languages.
 */
import { describe, it, expect } from 'vitest';
import { orderCancelledNotChargedTemplate as t } from '@api/services/email-templates/order-cancelled-not-charged';

const base = { orderNumber: 'ORD-1', customerName: 'Sam <b>', customerEmail: 'x@y.z' };
const flat = (html: string) => html.replace(/\s+/g, ' ');

describe('order-cancelled email — not charged', () => {
  const d = { ...base, charged: false };
  it('en', () => {
    const html = flat(t.en(d));
    expect(html).toContain(
      'Your order <strong>#ORD-1</strong> was cancelled. You were not charged.'
    );
    expect(html).not.toContain('refund');
    expect(html).not.toContain('<b>'); // name escaped
    expect(t.subject.en(d)).toBe('Order #ORD-1 cancelled');
  });
  it('ar', () => {
    const html = flat(t.ar(d));
    expect(html).toContain('تم إلغاء طلبك رقم <strong>ORD-1</strong>. لم يتم خصم أي مبلغ منك.');
    expect(html).not.toContain('استرداد');
  });
});

describe('order-cancelled email — captured, refund pending', () => {
  const d = { ...base, charged: true };
  it('en', () => {
    const html = flat(t.en(d));
    expect(html).toContain(
      'Your order <strong>#ORD-1</strong> was cancelled. Your refund is being processed.'
    );
    expect(html).not.toContain('not charged');
  });
  it('ar', () => {
    const html = flat(t.ar(d));
    expect(html).toContain('تم إلغاء طلبك رقم <strong>ORD-1</strong>. جارٍ معالجة استرداد المبلغ.');
    expect(html).not.toContain('لم يتم خصم');
  });
});
