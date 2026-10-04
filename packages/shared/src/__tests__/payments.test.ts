import { describe, it, expect } from 'vitest';
import {
  AWAITING_PAYMENT_CONFIRMATION,
  INSTAPAY_DEFAULT_EXPIRY_HOURS,
  INSTAPAY_MAX_EXPIRY_HOURS,
  NON_REVENUE_ORDER_STATUSES,
  UNFULFILLABLE_ORDER_STATUSES,
  codSettingsSchema,
  instapayReferenceSchema,
  instapaySettingsBaseSchema,
  instapaySettingsSchema,
  isAwaitingPaymentConfirmation,
} from '../payments';
import { ORDER_LIST_STATUSES } from '../schemas/list-filters';

describe('revenue and fulfilment status sets (SP6a, Review Focus 3)', () => {
  it('an awaiting-confirmation order is not revenue and not fulfillable', () => {
    expect(NON_REVENUE_ORDER_STATUSES).toContain(AWAITING_PAYMENT_CONFIRMATION);
    expect(NON_REVENUE_ORDER_STATUSES).toContain('cancelled');
    expect(NON_REVENUE_ORDER_STATUSES).toContain('refunded');
    expect(UNFULFILLABLE_ORDER_STATUSES).toEqual([AWAITING_PAYMENT_CONFIRMATION]);
    expect(isAwaitingPaymentConfirmation('awaiting_payment_confirmation')).toBe(true);
    expect(isAwaitingPaymentConfirmation('confirmed')).toBe(false);
  });

  it('the order list can be filtered to it (the "Awaiting InstaPay confirmation" view)', () => {
    expect(ORDER_LIST_STATUSES).toContain(AWAITING_PAYMENT_CONFIRMATION);
  });
});

describe('InstaPay settings', () => {
  it('needs a handle or a phone once enabled, and defaults the hold to 48 hours', () => {
    expect(instapaySettingsSchema.safeParse({}).success).toBe(false);
    const ok = instapaySettingsSchema.parse({ handle: 'amelia@instapay' });
    expect(ok.expiryHours).toBe(INSTAPAY_DEFAULT_EXPIRY_HOURS);
    expect(INSTAPAY_DEFAULT_EXPIRY_HOURS).toBe(48);
    expect(instapaySettingsSchema.safeParse({ phone: '01012345678' }).success).toBe(true);
  });

  it('a disabled draft may be partial', () => {
    expect(instapaySettingsBaseSchema.safeParse({ accountName: 'Amelia' }).success).toBe(true);
  });

  it('rejects a malformed handle, a non-Egyptian phone and an out-of-range hold', () => {
    expect(instapaySettingsSchema.safeParse({ handle: 'no-at-sign' }).success).toBe(false);
    expect(instapaySettingsSchema.safeParse({ handle: 'a b@instapay' }).success).toBe(false);
    expect(instapaySettingsSchema.safeParse({ phone: '0551234567' }).success).toBe(false);
    expect(
      instapaySettingsSchema.safeParse({ handle: 'a1@instapay', expiryHours: 0 }).success
    ).toBe(false);
    expect(
      instapaySettingsSchema.safeParse({
        handle: 'a1@instapay',
        expiryHours: INSTAPAY_MAX_EXPIRY_HOURS + 1,
      }).success
    ).toBe(false);
    expect(
      instapaySettingsSchema.safeParse({ handle: 'a1@instapay', expiryHours: 1.5 }).success
    ).toBe(false);
  });

  it('the customer reference takes letters, digits and a few separators, nothing executable', () => {
    expect(instapayReferenceSchema.safeParse('IPN 4821-9937').success).toBe(true);
    expect(instapayReferenceSchema.safeParse('مرجع 12345').success).toBe(true);
    expect(instapayReferenceSchema.safeParse('<script>').success).toBe(false);
    expect(instapayReferenceSchema.safeParse('ab').success).toBe(false);
    expect(instapayReferenceSchema.safeParse('x'.repeat(65)).success).toBe(false);
  });

  it('COD percentage is basis points, 0 to 50%', () => {
    expect(codSettingsSchema.parse({}).percentBps).toBe(0);
    expect(codSettingsSchema.safeParse({ percentBps: 5001 }).success).toBe(false);
    expect(codSettingsSchema.safeParse({ percentBps: 1.5 }).success).toBe(false);
  });
});
