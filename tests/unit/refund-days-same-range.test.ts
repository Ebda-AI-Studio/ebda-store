/**
 * Ruling (coordinator 2026-10-16): the refund timeframe is "5–10 business days" in BOTH
 * languages (the conservative choice). The Arabic refund email said 5-10 while the English said
 * 1–3, and the SMS said 3-5. This pins every refund-timeframe sentence (email ar + en, SMS ar +
 * en) to the same range.
 */
import { describe, it, expect } from 'vitest';
import { SMS_TEMPLATES } from '@ebda/shared';
import { orderRefundedTemplate } from '@api/services/email-templates/order-refunded';

const data = {
  customerName: 'Sara',
  orderNumber: 'ORD-1',
  refundAmount: 100,
  orderTotal: 100,
  currency: 'EGP',
} as never;

/** "5–10", "5-10", "5 إلى 10", "5 لـ 10", "٥–١٠" → [5, 10]; every range in the text. */
function ranges(text: string): Array<[number, number]> {
  const t = text.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return [...t.matchAll(/(\d+)\s*(?:[–-]|إلى|لـ|to)\s*(\d+)/g)].map(m => [+m[1], +m[2]]);
}

describe('refund timeframe: one range in every language and channel', () => {
  const texts: Record<string, string> = {
    'email en': orderRefundedTemplate.en(data),
    'email ar': orderRefundedTemplate.ar(data),
    'sms en': SMS_TEMPLATES.refund_processed.en,
    'sms ar': SMS_TEMPLATES.refund_processed.ar,
  };

  for (const [name, text] of Object.entries(texts))
    it(`${name} says 5–10 business days`, () => {
      expect(ranges(text)).toEqual([[5, 10]]);
    });
});
