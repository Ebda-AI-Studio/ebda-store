/**
 * #626: the Fawry route-level dedupe key is built from the same signed fields as the adapter's eventId, so a SECOND
 * partial refund notice (same fawryRefNumber, same PARTIALLY_REFUNDED status) is not dropped as "already processed".
 */
import { describe, expect, it } from 'vitest';
import { webhookRefs } from '@api/services/payment-providers/webhook-signature';

const notice = (over: Record<string, unknown> = {}) => ({
  fawryRefNumber: '9990001',
  merchantRefNumber: 'ORD-1',
  orderStatus: 'PARTIALLY_REFUNDED',
  paymentMethod: 'CARD',
  paymentAmount: '1000.00',
  orderAmount: '1000.00',
  messageSignature: 'x',
  ...over,
});
const key = (p: Record<string, unknown>) => webhookRefs('fawry', p).idempotencyKey;

describe('Fawry webhook idempotency key (#626)', () => {
  it('two partial refunds of one order get different keys (by paymentRefrenceNumber)', () => {
    expect(key(notice({ paymentRefrenceNumber: 'RF-1' }))).not.toBe(
      key(notice({ paymentRefrenceNumber: 'RF-2' }))
    );
  });

  it('two partial refunds that differ only in the signed amount get different keys', () => {
    expect(key(notice({ paymentAmount: '200.00' }))).not.toBe(
      key(notice({ paymentAmount: '300.00' }))
    );
  });

  it('a redelivery of the same notice keeps the same key, however the amount is written', () => {
    const a = notice({ paymentRefrenceNumber: 'RF-1', paymentAmount: '200.00' });
    expect(key(a)).toBe(key({ ...a }));
    expect(key(a)).toBe(key({ ...a, paymentAmount: 200 }));
  });

  it('matches the adapter eventId fields: ref, status, amount in piastres, reference number', () => {
    expect(key(notice({ paymentRefrenceNumber: 'RF-9', paymentAmount: '12.50' }))).toBe(
      'fawry_9990001_PARTIALLY_REFUNDED_1250_RF-9'
    );
  });
});
