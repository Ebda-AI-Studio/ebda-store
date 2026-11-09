/**
 * Issue 2426 — billed SMS segments, and the budget the opt-out link spends.
 */
import { describe, it, expect } from 'vitest';
import { smsSegments } from '../../apps/api/src/lib/sms-segments';
import { SMS_TEMPLATES, renderSmsTemplate } from '../../packages/shared/src/notifications';

describe('smsSegments', () => {
  it('GSM-7: 160 in one segment, 153 per segment after', () => {
    expect(smsSegments('')).toEqual({ encoding: 'gsm7', units: 0, segments: 0 });
    expect(smsSegments('a'.repeat(160)).segments).toBe(1);
    expect(smsSegments('a'.repeat(161)).segments).toBe(2);
    expect(smsSegments('a'.repeat(306)).segments).toBe(2);
    expect(smsSegments('a'.repeat(307)).segments).toBe(3);
  });

  it('extension characters cost two septets', () => {
    expect(smsSegments('{}').units).toBe(4);
    expect(smsSegments('€'.repeat(80)).segments).toBe(1);
    expect(smsSegments('€'.repeat(81)).segments).toBe(2);
  });

  it('one non-GSM character switches the whole message to UCS-2 (70 / 67)', () => {
    expect(smsSegments('a'.repeat(70)).encoding).toBe('gsm7');
    const arabic = 'مرحبا';
    expect(smsSegments(arabic)).toEqual({ encoding: 'ucs2', units: 5, segments: 1 });
    expect(smsSegments('a'.repeat(69) + 'م').segments).toBe(1);
    expect(smsSegments('a'.repeat(70) + 'م').segments).toBe(2);
    expect(smsSegments('a'.repeat(134) + 'م').segments).toBe(3);
  });
});

describe('promotional SMS length budget (issue 2426)', () => {
  // The appended text the dispatcher adds, at its fixed shape: label, a
  // platform-path base and a 68-char v3 token (consent id, store id, MAC).
  const base = 'https://ebda.app/some-store-slug';
  const suffix = ` Stop offers: ${base}/sms-unsubscribe?t=${'x'.repeat(22)}.${'s'.repeat(22)}.${'y'.repeat(22)}`;

  it('the opt-out suffix costs 101 characters plus the storefront base', () => {
    expect(suffix.length).toBe(101 + base.length);
  });

  it.each([
    'cart_abandoned_step1',
    'cart_abandoned_step2',
    'cart_abandoned_step3',
    'back_in_stock',
  ] as const)('%s with a realistic link and the opt-out stays within 2 GSM-7 segments', event => {
    const body = renderSmsTemplate(SMS_TEMPLATES[event].en, {
      customerName: 'Fatima',
      customerPhone: '96551234567',
      orderNumber: '',
      storeId: 's',
      storeName: 'Pecan Bee',
      cartUrl: `${base}/cart?r=abcdef0123456789`,
      productName: 'Pecan box 500g',
      productUrl: `${base}/products/pecan-box-500g`,
    } as never);
    const cost = smsSegments(body + suffix);
    expect(cost.encoding).toBe('gsm7');
    expect(cost.segments).toBeLessThanOrEqual(2);
  });
});
