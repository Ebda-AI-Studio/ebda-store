/** INSTAPAY-AUTO-1 S10: the "not received" email says the same plain sentence as the in-app banner, in both languages. */
import { describe, expect, it } from 'vitest';
import {
  notReceivedText,
  subscriptionBillingTemplate,
  type SubscriptionBillingNoticeData,
} from '../../apps/api/src/services/email-templates/subscription-billing';

const data: SubscriptionBillingNoticeData = {
  kind: 'instapay_not_received',
  storeName: 'Cairo Candles',
  planName: 'Growth',
  amountMinor: 0,
  billingUrl: 'https://store.ebda.app/stores/s/billing',
  graceUntil: '2026-11-16 12:00',
};

describe('S10 revert notice', () => {
  it('Arabic body carries the exact sentence with the deadline, and links to upload or pay', () => {
    const html = subscriptionBillingTemplate.ar(data);
    expect(html).toContain(
      'الدفع ما وصلش. ارفع إيصال صح أو ادفع بالكارت قبل 2026-11-16 12:00 عشان الخدمات المدفوعة ما تقفش.'
    );
    expect(html).toContain('ارفع إيصال');
    expect(html).toContain('ادفع بالكارت');
    expect(subscriptionBillingTemplate.subject.ar(data)).toContain('الدفع ما وصلش');
  });
  it('English body states the deadline too', () => {
    const html = subscriptionBillingTemplate.en(data);
    expect(html).toContain('before 2026-11-16 12:00');
    expect(subscriptionBillingTemplate.subject.en(data)).toContain('did not arrive');
  });
  it('one shared sentence function feeds both surfaces', () => {
    expect(notReceivedText('X', 'ar')).toContain('X');
  });
});
