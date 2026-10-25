/**
 * The return-reason mapper (CI 1.1/1.8). Fixture strings are the carriers' EXPECTED wording
 * (docs/ebda/research/egypt-shipping-carriers.md: real status strings are unverified); the live `other`
 * rate alert is what proves the tables once real returns arrive.
 */
import { describe, expect, it } from 'vitest';
import {
  RETURN_REASON_CODES,
  mapReturnReason,
  scrubFreeText,
} from '../../apps/api/src/lib/ci/return-reason';

describe('mapReturnReason', () => {
  it.each([
    ['bosta', 'Consignee refused to receive the order', 'customer_refused'],
    ['bosta', 'Consignee not available', 'customer_unreachable'],
    ['shipblu', 'Customer not reachable', 'customer_unreachable'],
    ['shipblu', 'Cancelled by customer', 'customer_refused'],
    ['mylerz', 'Receiver refused', 'customer_refused'],
    ['mylerz', 'Receiver unreachable', 'customer_unreachable'],
    ['aramex', 'Consignee refused delivery', 'customer_refused'],
    ['aramex', 'Incorrect consignee address', 'wrong_address'],
    ['aramex', 'Consignee not in', 'customer_unreachable'],
    ['manual', 'العميل رفض الاستلام', 'customer_refused'],
    ['manual', 'العميل مش بيرد', 'customer_unreachable'],
    ['manual', 'عنوان غلط', 'wrong_address'],
    ['manual', 'العنوان غير كامل', 'address_incomplete'],
    ['manual', 'طلب التأجيل لبكرة', 'customer_postponed'],
    ['bosta', 'Shipment damaged in transit', 'damaged_in_transit'],
    ['bosta', 'Maximum attempts exceeded', 'courier_failed_attempts'],
    ['bosta', 'Parcel lost by courier', 'courier_lost'],
    ['manual', 'duplicate order', 'duplicate_order'],
    ['manual', 'fake order', 'fake_order'],
    ['manual', 'the price is too high', 'price_dispute'],
    ['manual', 'not as described', 'product_not_as_described'],
  ])('%s: "%s" -> %s', (carrier, raw, code) => {
    expect(mapReturnReason(carrier, raw).code).toBe(code);
  });

  it('unknown phrases are `other` and keep the scrubbed raw text', () => {
    expect(mapReturnReason('bosta', 'Something nobody anticipated')).toEqual({
      code: 'other',
      raw: 'Something nobody anticipated',
    });
    expect(mapReturnReason('bosta', null)).toEqual({ code: 'other', raw: null });
    expect(mapReturnReason('unknown-carrier', 'refused').code).toBe('customer_refused');
  });

  it('only ever returns a code from the closed list', () => {
    for (const raw of ['x', 'refused', 'lost', 'مفقود', '']) {
      expect(RETURN_REASON_CODES).toContain(mapReturnReason('bosta', raw).code);
    }
  });
});

describe('scrubFreeText', () => {
  it('masks phones, emails and links; folds whitespace; cuts to 200', () => {
    expect(
      scrubFreeText('Call 01001234567 or +20 100 123 4567, mail a.b@c.com see https://x.io/p?q=1')
    ).toBe('Call [phone] or [phone], mail [email] see [link]');
    expect(scrubFreeText('a\n\n b\t c')).toBe('a b c');
    expect(scrubFreeText('x'.repeat(500))?.length).toBe(200);
    expect(scrubFreeText('   ')).toBeNull();
    expect(scrubFreeText(42)).toBeNull();
  });

  it('masks Arabic-Indic and Persian digit phones and mixed-digit phones (Egypt)', () => {
    expect(scrubFreeText('اتصل ٠١٠١٢٣٤٥٦٧٨ دلوقتي')).toBe('اتصل [phone] دلوقتي');
    expect(scrubFreeText('call ۰۱۰۱۲۳۴۵۶۷۸ now')).toBe('call [phone] now');
    expect(scrubFreeText('01٠1234٥678')).toBe('[phone]');
    expect(scrubFreeText('+٢٠ ١٠٠ ١٢٣ ٤٥٦٧')).toBe('[phone]');
  });
});
