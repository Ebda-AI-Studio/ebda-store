/**
 * Signup funnel — pure decisions (Rulings EBDA-FUNNEL-1..14):
 *   go-live verdict, trial card mode, reminder schedule, next charge, upsell
 *   target, provider card-setup capability, and the over-limit read-only gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { upgradePlanFor } from '@ebda/shared';
import { goLiveVerdict } from '@api/services/billing/go-live-gate';
import { resolveTrialCardMode } from '@api/services/billing';
import { StubBillingProvider } from '@api/services/billing/stub.provider';
import { KashierBillingProvider } from '@api/services/billing/kashier.provider';
import { BillingProviderError } from '@api/services/billing/types';
import { reminderKindAt, reminderDueAt } from '@api/services/billing/reminders.service';
import { nextChargeOf } from '@api/services/billing/subscription-billing.service';
import { PLATFORM_VAT_OFF } from '@api/services/billing/charge-amount';
import { instapayHandle, supportWhatsappUrl } from '@api/services/billing/manual-config';

const DAY = 86_400_000;
const now = new Date('2026-10-07T10:00:00.000Z');
const later = new Date(now.getTime() + 5 * DAY);
const base = {
  status: 'trialing',
  planCode: 'growth',
  trialEndsAt: later,
  provider: null as string | null,
  providerPaymentMethodRef: null as string | null,
  billingMethod: null as string | null,
};

describe('goLiveVerdict', () => {
  it('trial without card or InstaPay -> PAYMENT_METHOD_REQUIRED', () => {
    expect(goLiveVerdict(base, 'card_on_file', now)).toEqual({
      ok: false,
      code: 'PAYMENT_METHOD_REQUIRED',
    });
  });
  it('trial with a saved card -> ok', () => {
    expect(
      goLiveVerdict(
        { ...base, provider: 'stub', providerPaymentMethodRef: 'enc' },
        'card_on_file',
        now
      )
    ).toMatchObject({ ok: true, reason: 'trial_with_card' });
  });
  it('a card token without a provider is not a usable card', () => {
    expect(
      goLiveVerdict({ ...base, providerPaymentMethodRef: 'enc' }, 'card_on_file', now).ok
    ).toBe(false);
  });
  it('trial with InstaPay chosen -> ok', () => {
    expect(
      goLiveVerdict({ ...base, billingMethod: 'instapay' }, 'pay_at_trial_end', now)
    ).toMatchObject({ ok: true, reason: 'trial_instapay' });
  });
  it('expired trial -> TRIAL_EXPIRED even with a card', () => {
    expect(
      goLiveVerdict(
        { ...base, trialEndsAt: now, provider: 'stub', providerPaymentMethodRef: 'e' },
        'card_on_file',
        now
      )
    ).toEqual({ ok: false, code: 'TRIAL_EXPIRED' });
  });
  it('granted plans and comped status pass; canceled/past_due do not', () => {
    expect(
      goLiveVerdict({ ...base, planCode: 'founding_free', status: 'active' }, 'card_on_file', now)
        .ok
    ).toBe(true);
    expect(goLiveVerdict({ ...base, status: 'comped' }, 'card_on_file', now).ok).toBe(true);
    expect(
      goLiveVerdict({ ...base, status: 'canceled', billingMethod: 'instapay' }, 'card_on_file', now)
        .ok
    ).toBe(false);
    expect(
      goLiveVerdict({ ...base, status: 'past_due', billingMethod: 'instapay' }, 'card_on_file', now)
        .ok
    ).toBe(false);
  });
  it('no subscription -> NO_SUBSCRIPTION', () => {
    expect(goLiveVerdict(null, 'card_on_file', now)).toEqual({
      ok: false,
      code: 'NO_SUBSCRIPTION',
    });
  });
});

describe('resolveTrialCardMode (InstaPay-only by default, Ruling EBDA-FUNNEL-17)', () => {
  const stub = new StubBillingProvider();
  const kashier = new KashierBillingProvider({
    baseUrl: '',
    merchantId: 'm',
    secretKey: 's',
    apiKey: 'a',
  });
  it('unset = pay_at_trial_end on every provider (card hidden)', () => {
    expect(resolveTrialCardMode(stub, {})).toBe('pay_at_trial_end');
    expect(resolveTrialCardMode(kashier, {})).toBe('pay_at_trial_end');
  });
  it('production with NO billing provider configured still resolves (no gateway needed)', () => {
    expect(resolveTrialCardMode(undefined, { NODE_ENV: 'production' })).toBe('pay_at_trial_end');
  });
  it('card only when explicitly on AND the provider can save without a charge', () => {
    expect(resolveTrialCardMode(stub, { BILLING_TRIAL_CARD_MODE: 'card_on_file' })).toBe(
      'card_on_file'
    );
    expect(() =>
      resolveTrialCardMode(kashier, { BILLING_TRIAL_CARD_MODE: 'card_on_file' })
    ).toThrow(/cannot save a card/);
    expect(() => resolveTrialCardMode(stub, { BILLING_TRIAL_CARD_MODE: 'free' })).toThrow();
  });
});

describe('providers: card setup', () => {
  it('Kashier refuses card setup BEFORE any network call (notCharged)', async () => {
    const fetchImpl = vi.fn();
    const k = new KashierBillingProvider({
      baseUrl: 'https://x',
      merchantId: 'm',
      secretKey: 's',
      apiKey: 'a',
      fetchImpl,
    });
    await expect(
      k.createCardSetupSession({
        merchantOrderId: 'o',
        customer: { reference: 'r', email: 'e@x.com' },
        returnUrl: 'https://a',
        webhookUrl: 'https://b',
      })
    ).rejects.toMatchObject({ notCharged: true });
    await expect(
      k.createCardSetupSession({
        merchantOrderId: 'o',
        customer: { reference: 'r', email: 'e@x.com' },
        returnUrl: 'https://a',
        webhookUrl: 'https://b',
      })
    ).rejects.toBeInstanceOf(BillingProviderError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('the stub saves a card with no charge and returns to our URL', async () => {
    const s = new StubBillingProvider();
    const out = await s.createCardSetupSession({
      merchantOrderId: 'abc',
      customer: { reference: 'r', email: 'e@x.com' },
      returnUrl: 'https://admin/onboarding?card=return',
      webhookUrl: 'https://api/x',
    });
    expect(out.redirectUrl).toBe('https://admin/onboarding?card=return&stub=1&merchantOrderId=abc');
    expect(s.chargeCalls).toHaveLength(0);
  });
  it('a stub card.saved delivery carries last4/brand but the raw payload drops the token', () => {
    const s = new StubBillingProvider();
    const { rawBody, headers } = StubBillingProvider.signedWebhook({
      id: 'e1',
      type: 'card.saved',
      merchantOrderId: 'o',
      chargeId: null,
      amountMinor: 0,
      token: 'tok_secret',
      last4: '4242',
      brand: 'visa',
    });
    const ev = s.verifyWebhook(rawBody, headers);
    expect(ev.card).toEqual({ token: 'tok_secret', last4: '4242', brand: 'visa' });
    expect(JSON.stringify(ev.raw)).not.toContain('tok_secret');
  });
});

describe('reminder schedule', () => {
  const due = new Date('2026-10-20T04:00:00.000Z');
  it.each([
    [8, null],
    [7, 'd7'],
    [5, 'd7'],
    [3, 'd3'],
    [2, 'd3'],
    [1, 'd1'],
    [0, 'd0'],
  ])('%s days before -> %s', (days, kind) => {
    expect(reminderKindAt(due, new Date(due.getTime() - (days as number) * DAY))).toBe(kind);
  });
  it('past the due day there is no reminder (the overdue path takes over)', () => {
    expect(reminderKindAt(due, new Date(due.getTime() + DAY))).toBeNull();
    expect(reminderKindAt(due, new Date(due.getTime() + DAY - 1))).toBe('d0');
  });
  it('due date: trial end while trialing, period end otherwise, none when canceled', () => {
    expect(reminderDueAt({ status: 'trialing', trialEndsAt: due, currentPeriodEnd: null })).toBe(
      due
    );
    expect(reminderDueAt({ status: 'active', trialEndsAt: null, currentPeriodEnd: due })).toBe(due);
    expect(
      reminderDueAt({ status: 'canceled', trialEndsAt: due, currentPeriodEnd: due })
    ).toBeNull();
  });
});

describe('nextChargeOf', () => {
  const plans = [
    { code: 'basic', priceMonthlyMinor: 149000, priceYearlyMinor: 1341000 },
    { code: 'growth', priceMonthlyMinor: 349000, priceYearlyMinor: 3141000 },
  ];
  const sub = {
    status: 'trialing',
    planCode: 'growth',
    pendingPlanCode: 'basic',
    billingInterval: 'yearly',
    trialEndsAt: later,
    currentPeriodEnd: later,
    nextRetryAt: null,
    cancelAtPeriodEnd: false,
    providerPaymentMethodRef: 'x',
  };
  it('a trial bills the CHOSEN plan at the chosen interval on the trial end', () => {
    expect(nextChargeOf(sub, plans, PLATFORM_VAT_OFF)).toEqual({
      at: later,
      planCode: 'basic',
      amountMinor: 1341000,
      vat: null,
    });
  });
  it('BILLING-INTERVAL-PENDING-1: an active yearly store keeps the yearly renewal quote; the override prices the pending pick', () => {
    const active = { ...sub, status: 'active', pendingPlanCode: null, billingInterval: 'yearly' };
    expect(nextChargeOf(active, plans, PLATFORM_VAT_OFF)).toMatchObject({
      at: later,
      planCode: 'growth',
      amountMinor: 3141000,
    });
    expect(nextChargeOf(active, plans, PLATFORM_VAT_OFF, 'monthly')).toMatchObject({
      amountMinor: 349000,
    });
  });
  it('Ebda VAT exclusive: the next charge adds 14% and carries the VAT line', () => {
    const vat = {
      enabled: true,
      rateBps: 1400,
      mode: 'exclusive' as const,
      trn: '1',
      legalName: 'W',
    };
    expect(nextChargeOf(sub, plans, vat)).toMatchObject({
      amountMinor: 1528740,
      vat: { netMinor: 1341000, vatMinor: 187740, rateBps: 1400, trn: '1' },
    });
  });
  it('nothing when canceling, comped or free', () => {
    const off = PLATFORM_VAT_OFF;
    expect(nextChargeOf({ ...sub, cancelAtPeriodEnd: true }, plans, off)).toBeNull();
    expect(nextChargeOf({ ...sub, planCode: 'comped', status: 'comped' }, plans, off)).toBeNull();
    expect(nextChargeOf({ ...sub, planCode: 'free', status: 'canceled' }, plans, off)).toBeNull();
  });
});

describe('upsell target (cheapest public plan that fits)', () => {
  it.each([
    ['maxStores', 2, 'business'],
    ['maxOrdersPerMonth', 301, 'growth'],
    ['maxOrdersPerMonth', 3001, 'business'],
    ['brandingRemoval', true, 'growth'],
    ['apiAccess', true, 'business'],
    ['merchantMcp', true, 'growth'],
    ['analyticsTier', 'standard', 'growth'],
    ['analyticsTier', 'advanced', 'business'],
  ])('%s needs %s -> %s', (key, need, code) => {
    expect(upgradePlanFor(key as string, need)?.code).toBe(code);
  });
  it('carries both names for the Arabic/English UI', () => {
    expect(upgradePlanFor('apiAccess', true)).toMatchObject({
      nameEn: 'Business',
      nameAr: expect.any(String),
    });
  });
});

describe('manual payment config', () => {
  it('no handle configured = InstaPay not offered', () => {
    expect(instapayHandle({})).toBeNull();
    expect(instapayHandle({ EBDA_INSTAPAY_HANDLE: '  ebda@instapay ' })).toBe('ebda@instapay');
  });
  it('wa.me link from an Egyptian mobile; none when unset', () => {
    expect(supportWhatsappUrl(undefined, {})).toBeNull();
    expect(supportWhatsappUrl('hi', { EBDA_SUPPORT_WHATSAPP: '01012345678' })).toBe(
      'https://wa.me/201012345678?text=hi'
    );
  });
});

// ── over-limit store is read-only for the merchant (requireStoreAccess) ──
const db = vi.hoisted(() => ({ store: vi.fn() }));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    prisma: { store: { findUnique: db.store } },
    // requireStoreAccess reads the store inside its own scope (`withStore`, strict RLS).
    withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
      fn({ store: { findUnique: db.store } }),
  };
});
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));

const OVER_LIMIT_STORE_ID = '11111111-1111-4111-8111-111111111111';
describe('requireStoreAccess: over_store_limit store', () => {
  beforeEach(() => db.store.mockReset());
  async function call(method: string, path: string, role = 'store_admin') {
    const { requireStoreAccess } = await import('@api/middleware/store-access');
    db.store.mockResolvedValue({
      id: OVER_LIMIT_STORE_ID,
      ownerId: 'u1',
      name: 'S',
      status: 'suspended',
      billingSuspendedReason: 'over_store_limit',
    });
    const next = vi.fn();
    const [baseUrl, sub] = path.split('|');
    await requireStoreAccess(
      {
        method,
        params: { storeId: OVER_LIMIT_STORE_ID },
        user: { userId: 'u1', role },
        baseUrl,
        path: sub ?? '/',
        headers: {},
      } as never,
      {} as never,
      next
    );
    return next.mock.calls[0]?.[0];
  }
  it('refuses a merchant write with a 402 upsell to Business', async () => {
    const err = await call('PUT', '/api/v1/stores/s1/products|/p1');
    expect(err).toMatchObject({
      statusCode: 402,
      code: 'STORE_OVER_PLAN_LIMIT',
      details: { upgradeTo: { code: 'business' } },
    });
  });
  it('allows reads and billing writes (so the merchant can upgrade)', async () => {
    expect(await call('GET', '/api/v1/stores/s1/products|/')).toBeUndefined();
    expect(await call('POST', '/api/v1/stores/s1/billing|/checkout')).toBeUndefined();
  });
  it('a super-admin is not bound', async () => {
    expect(await call('PUT', '/api/v1/stores/s1/products|/p1', 'super_admin')).toBeUndefined();
  });
});

describe('subscription charge amount (single platform-VAT seam)', () => {
  it('VAT OFF (today): total equals the plan price exactly, no VAT line', async () => {
    const { subscriptionChargeAmount, PLATFORM_VAT_OFF: off } =
      await import('@api/services/billing/charge-amount');
    expect(subscriptionChargeAmount(349000, off)).toEqual({
      totalMinor: 349000,
      netMinor: 349000,
      vatMinor: 0,
      vat: null,
    });
  });
  it('exclusive 14%: VAT added on top, half-up, with TRN on the line', async () => {
    const { subscriptionChargeAmount } = await import('@api/services/billing/charge-amount');
    const vat = {
      enabled: true,
      rateBps: 1400,
      mode: 'exclusive' as const,
      trn: '123',
      legalName: 'Ebda AI Studio',
    };
    expect(subscriptionChargeAmount(149000, vat)).toMatchObject({
      totalMinor: 169860,
      netMinor: 149000,
      vatMinor: 20860,
      vat: { trn: '123' },
    });
    expect(subscriptionChargeAmount(1, vat).totalMinor).toBe(1); // 0.14 piastre rounds to 0
    expect(subscriptionChargeAmount(4, vat).vatMinor).toBe(1); // 0.56 rounds up
  });
  it('inclusive 14%: total unchanged, VAT carved out, parts add up', async () => {
    const { subscriptionChargeAmount } = await import('@api/services/billing/charge-amount');
    const vat = { enabled: true, rateBps: 1400, mode: 'inclusive' as const };
    const r = subscriptionChargeAmount(349000, vat);
    expect(r.totalMinor).toBe(349000);
    expect(r.netMinor + r.vatMinor).toBe(349000);
    expect(r.netMinor).toBe(306140);
  });
});
