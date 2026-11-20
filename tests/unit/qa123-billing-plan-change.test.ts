/**
 * QA-123 (plan picker on a Business-yearly store) + the InstaPay payee list (Ahmad: handle AND mobile of ONE account).
 * Mutation checks (each makes a test below fail):
 *   Q1 resumeSubscription stops restoring billingInterval          -> "keep my plan restores the yearly interval"
 *   Q2 downgradePaymentNotDue always false                         -> "a downgrade payment a year early is not due"
 *   Q3 instapayPayees drops the mobile                             -> payees + receipt tests
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sub: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
}));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  const tx = {
    storeSubscription: {
      findUnique: async () => state.sub,
      update: async (a: { data: Record<string, unknown> }) => {
        state.updates.push(a.data);
        state.sub = { ...state.sub, ...a.data };
        return state.sub;
      },
    },
  };
  return { ...real, withStore: (_id: string, fn: (t: unknown) => unknown) => fn(tx) };
});

import {
  comparableReceiver,
  computeReceiptFlags,
} from '@api/services/payment-providers/instapay-receipt.service';
import {
  downgradePaymentNotDue,
  maskIfNotDue,
  manualPeriodFor,
  DOWNGRADE_PAYMENT_WINDOW_DAYS,
} from '@api/services/billing/account.service';
import { instapayMobile, instapayPayees } from '@api/services/billing/manual-config';
import { intervalOfPeriod } from '@api/services/billing/period';
import { resumeSubscription } from '@api/services/billing/subscription-billing.service';

const D = (s: string) => new Date(`${s}T00:00:00Z`);

describe('QA-123 (a) keep my plan restores plan, interval and the due line', () => {
  beforeEach(() => {
    state.updates = [];
    // Business YEARLY, paid 2026-11-12 -> 2027-11-12; the picker scheduled Basic MONTHLY (billingInterval overwritten)
    state.sub = {
      status: 'active',
      planCode: 'business',
      pendingPlanCode: 'basic',
      billingInterval: 'monthly',
      currentPeriodStart: D('2026-11-12'),
      currentPeriodEnd: D('2027-11-12'),
      cancelAtPeriodEnd: false,
    };
  });
  it('keep my plan restores the yearly interval', async () => {
    await resumeSubscription({ storeId: 's1' });
    expect(state.sub).toMatchObject({ pendingPlanCode: null, billingInterval: 'yearly' });
  });
  it('a monthly store stays monthly; a store with no pending change is not touched', async () => {
    state.sub = {
      ...state.sub,
      currentPeriodStart: D('2026-11-12'),
      currentPeriodEnd: D('2026-12-12'),
    };
    await resumeSubscription({ storeId: 's1' });
    expect(state.sub).toMatchObject({ billingInterval: 'monthly' });
    state.updates = [];
    state.sub = { ...state.sub, pendingPlanCode: null, billingInterval: 'yearly' };
    await resumeSubscription({ storeId: 's1' });
    expect(state.updates[0]).not.toHaveProperty('billingInterval');
  });
  it('intervalOfPeriod reads the paid period, null when the dates cannot say', () => {
    expect(
      intervalOfPeriod({ currentPeriodStart: D('2026-11-12'), currentPeriodEnd: D('2027-11-12') })
    ).toBe('yearly');
    expect(
      intervalOfPeriod({ currentPeriodStart: D('2026-11-12'), currentPeriodEnd: D('2026-12-12') })
    ).toBe('monthly');
    expect(
      intervalOfPeriod({ currentPeriodStart: null, currentPeriodEnd: D('2026-12-12') })
    ).toBeNull();
  });
});

describe('QA-123 (b) a downgrade is not paid for a year ahead', () => {
  const sub = (end: string) => ({
    status: 'active',
    planCode: 'business',
    pendingPlanCode: 'basic',
    currentPeriodEnd: D(end),
  });
  const basic = { planCode: 'basic', amountMinor: 149_000 };
  it('a downgrade payment a year early is not due', () => {
    expect(downgradePaymentNotDue(sub('2027-11-12'), basic, 8_991_000, D('2026-11-20'))).toBe(true);
  });
  it('from 7 days before the period ends it is due (period then starts at the current end)', () => {
    expect(DOWNGRADE_PAYMENT_WINDOW_DAYS).toBe(7);
    expect(downgradePaymentNotDue(sub('2027-11-12'), basic, 8_991_000, D('2027-11-06'))).toBe(
      false
    );
    expect(downgradePaymentNotDue(sub('2027-11-12'), basic, 8_991_000, D('2027-11-04'))).toBe(true);
  });
  it('an upgrade (dearer than the current period) and a same-plan renewal are never blocked', () => {
    expect(
      downgradePaymentNotDue(
        { ...sub('2027-11-12'), planCode: 'basic', pendingPlanCode: 'business' },
        { planCode: 'business', amountMinor: 8_991_000 },
        149_000,
        D('2026-11-20')
      )
    ).toBe(false);
    expect(
      downgradePaymentNotDue(
        { ...sub('2026-12-01'), pendingPlanCode: null },
        { planCode: 'business', amountMinor: 999_000 },
        999_000,
        D('2026-11-20')
      )
    ).toBe(false);
  });
  it('unknown current price or no live period fails open to the existing rule', () => {
    expect(downgradePaymentNotDue(sub('2027-11-12'), basic, null, D('2026-11-20'))).toBe(false);
    expect(
      downgradePaymentNotDue(
        { ...sub('2027-11-12'), status: 'canceled' },
        basic,
        8_991_000,
        D('2026-11-20')
      )
    ).toBe(false);
  });
});

describe('InstaPay payee = handle OR mobile of the one Ebda account', () => {
  const env = {
    EBDA_INSTAPAY_HANDLE: 'voidengineer911@instapay',
    EBDA_INSTAPAY_MOBILE: '+201207761882',
  };
  it('lists both, mobile in local form; mobile optional; junk dropped', () => {
    expect(instapayPayees(env)).toEqual(['voidengineer911@instapay', '01207761882']);
    expect(instapayPayees({ EBDA_INSTAPAY_HANDLE: 'a@instapay' })).toEqual(['a@instapay']);
    expect(instapayMobile({ EBDA_INSTAPAY_MOBILE: 'abc' })).toBeNull();
    expect(instapayMobile({ EBDA_INSTAPAY_MOBILE: '٠١٢٠٧٧٦١٨٨٢' })).toBe('01207761882');
  });
  const flags = (receiverHandle: string | null, receiverMobile: string | null) =>
    computeReceiptFlags({
      fields: { amountMinor: 149_000, receiverHandle, receiverMobile } as never,
      transferredAt: D('2026-11-20'),
      extraction: null,
      extractionStatus: 'failed',
      expectedAmountMinor: 149_000,
      expectedReceivers: instapayPayees(env),
      notBefore: null,
      notBeforeFlag: 'DATE_TOO_OLD',
      sameImageSeenBefore: false,
      now: D('2026-11-20'),
    });
  it.each([
    ['handle', 'VoidEngineer911@InstaPay', null],
    ['mobile 01…', null, '01207761882'],
    ['mobile +20…', null, '+201207761882'],
    ['mobile 20…', null, '201207761882'],
    ['mobile Arabic-Indic', null, '٠١٢٠٧٧٦١٨٨٢'],
  ])('a receipt to the %s passes the payee check', (_n, h, m) => {
    const f = flags(h, m);
    expect(f).not.toContain('RECEIVER_MISMATCH');
    expect(f).not.toContain('RECEIVER_MISSING');
  });
  it('any other recipient still goes to review', () => {
    expect(flags('someone@instapay', null)).toContain('RECEIVER_MISMATCH');
    expect(flags(null, '01099999999')).toContain('RECEIVER_MISMATCH');
  });
});

describe('QA-123 (b) money is never refused: a not-due downgrade receipt is FLAGGED, and its approval keeps the period rule', () => {
  const base = {
    fields: {
      amountMinor: 149_000,
      receiverHandle: 'voidengineer911@instapay',
      receiverMobile: null,
    } as never,
    transferredAt: D('2026-11-20'),
    extraction: null,
    extractionStatus: 'failed',
    expectedAmountMinor: 149_000,
    expectedReceivers: ['voidengineer911@instapay'],
    notBefore: null,
    notBeforeFlag: 'DATE_TOO_OLD' as const,
    sameImageSeenBefore: false,
    now: D('2026-11-20'),
  };
  it('notDue adds PAYMENT_NOT_DUE and nothing else is dropped', () => {
    expect(computeReceiptFlags({ ...base, notDue: true })).toContain('PAYMENT_NOT_DUE');
    expect(computeReceiptFlags(base)).not.toContain('PAYMENT_NOT_DUE');
  });
  it('the approval period of an in-window downgrade starts at the CURRENT end (EBDA-MONEYA-6 unchanged)', () => {
    const sub = {
      status: 'active',
      trialEndsAt: null,
      currentPeriodEnd: D('2027-11-12'),
      billingAnchorDay: 12,
    };
    const p = manualPeriodFor(sub, 'monthly', D('2027-11-09'));
    expect(p.periodStart.toISOString()).toBe('2027-11-12T00:00:00.000Z');
    expect(p.periodEnd.toISOString()).toBe('2027-12-12T00:00:00.000Z');
  });
  it('the merchant view of a not-due downgrade carries no amount, payee or QR', () => {
    const d = {
      notDue: true,
      handle: 'a@instapay',
      mobile: '0120',
      qrUrl: 'https://x',
      amountMinor: 1,
      vat: {},
      reference: 'EBD-1',
    };
    expect(maskIfNotDue(d)).toMatchObject({
      handle: null,
      mobile: null,
      qrUrl: null,
      amountMinor: null,
      vat: null,
      reference: 'EBD-1',
    });
    const due = { ...d, notDue: false };
    expect(maskIfNotDue(due)).toBe(due);
  });
});

describe('payee compare is full E.164, not the last 10 digits', () => {
  it('forms of the same mobile agree; a number that only shares the last 10 digits does not', () => {
    const want = comparableReceiver('01207761882');
    expect(want).toBe('+201207761882');
    for (const f of [
      '+201207761882',
      '201207761882',
      '00201207761882',
      '٠١٢٠٧٧٦١٨٨٢',
      '0120 776 1882',
    ])
      expect(comparableReceiver(f)).toBe(want);
    expect(comparableReceiver('+441207761882')).toBeNull();
    expect(comparableReceiver('1207761882')).toBe(want); // the reader's last-10 form
    expect(comparableReceiver('01207761883')).not.toBe(want);
    expect(comparableReceiver('VoidEngineer911@InstaPay')).toBe('voidengineer911@instapay');
  });
});
