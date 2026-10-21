/**
 * Arabic SMS/push copy: the cart count is a counted noun ("قطعة واحدة / قطعتين / 3 قطع", never
 * "1 عناصر"), the back-in-stock text gives an arbitrary product name no gendered verb, a refund
 * text says it was issued ("رجعنالك"), and the payment SMS stays in one UCS-2 segment.
 */
import { describe, it, expect } from 'vitest';
import { SMS_TEMPLATES, PUSH_TEMPLATES, renderSmsTemplate } from '@ebda/shared';
import { smsSegments } from '../../apps/api/src/lib/sms-segments';

const data = (over: object = {}) =>
  ({
    customerName: 'سارة',
    orderNumber: 'ORD-1042',
    storeId: 's',
    storeName: 'وادي الجوز',
    cartTotal: '55.00',
    cartUrl: 'https://shop.example.test/cart?r=abcdef0123',
    amount: 120,
    ...over,
  }) as never;

describe('cart item count is a counted noun', () => {
  const ar = (n: number) =>
    renderSmsTemplate(SMS_TEMPLATES.cart_abandoned_step1.ar, data({ cartItemCount: n }), 'ar');
  it('ar: 1 / 2 / 3 / 11', () => {
    expect(ar(1)).toContain('سيبت قطعة واحدة (');
    expect(ar(2)).toContain('سيبت قطعتين (');
    expect(ar(3)).toContain('سيبت 3 قطع (');
    expect(ar(11)).toContain('سيبت 11 قطعة (');
    expect(ar(1)).not.toMatch(/1 عناصر|\{cart/);
  });
  it('en: 1 item / 2 items', () => {
    const en = (n: number) =>
      renderSmsTemplate(SMS_TEMPLATES.cart_abandoned_step1.en, data({ cartItemCount: n }), 'en');
    expect(en(1)).toContain('1 item (');
    expect(en(2)).toContain('2 items (');
  });
  it('the push body uses the same noun', () => {
    expect(
      renderSmsTemplate(
        PUSH_TEMPLATES.cart_abandoned_step1.body.ar,
        data({ cartItemCount: 2 }),
        'ar'
      )
    ).toContain('قطعتين');
  });
});

describe('gender-safe and issued-refund wording', () => {
  it('back in stock never gives the product name a verb of its own gender', () => {
    for (const t of [
      SMS_TEMPLATES.back_in_stock.ar,
      PUSH_TEMPLATES.back_in_stock.body.ar,
      PUSH_TEMPLATES.back_in_stock.title.ar,
    ]) {
      expect(t).not.toMatch(/"\{productName\}" (رجع|متوفر)/);
      expect(t).not.toMatch(/(^|\s)رجع(\s|$)/);
    }
    expect(SMS_TEMPLATES.back_in_stock.ar).toContain('رجّعنا "{productName}"');
  });

  it('refund texts say it was issued', () => {
    expect(SMS_TEMPLATES.refund_processed.ar).toContain('رجعنالك');
    expect(PUSH_TEMPLATES.refund_processed.title.ar).toBe('رجعنالك فلوسك');
    expect(PUSH_TEMPLATES.refund_processed.body.ar).toContain('رجعنالك');
  });
});

describe('payment_success SMS fits one segment', () => {
  it('<= 70 UCS-2 characters with realistic fills', () => {
    const body = renderSmsTemplate(SMS_TEMPLATES.payment_success.ar, data(), 'ar');
    expect(smsSegments(body)).toMatchObject({ encoding: 'ucs2', segments: 1 });
  });
});
