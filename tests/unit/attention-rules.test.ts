/** "Needs attention": every signal on and off, plan-gated signals never fire, action count. */
import { describe, it, expect } from 'vitest';
import { computeAttention } from '../../apps/api/src/services/attention.rules';
import { countActionItems, actionCountsBySection } from '@ebda/shared';

type AttentionFacts = Parameters<typeof computeAttention>[0];
// the ids the product ships (the registry in packages/shared/src/attention.ts is module-private: nothing outside imports it)
const ATTENTION_IDS = [
  'domain_unverified',
  'email_dns_missing',
  'gateway_connection_failed',
  'gateway_untested',
  'instapay_incomplete',
  'no_delivery_rates',
  'billing_past_due',
  'billing_claim_pending',
  'orders_over_limit',
  'tax_not_verified',
  'tax_review_pending',
  'chat_not_connected',
  'staff_invites_pending',
  'instapay_orders_unconfirmed',
  'payments_failed',
];

const clean: AttentionFacts = {
  features: { tax: true, whatsapp: true, staffAccounts: true },
  domain: { pendingDomain: null, domainStatus: null },
  emailDomain: { id: null, verifiedAt: null },
  gateways: [{ provider: 'paymob', healthStatus: 'healthy', testOk: true }],
  instapayHasDestination: true,
  products: 3,
  deliveryZones: 1,
  deliveryAreaRates: 0,
  subscription: { status: 'active', overLimitThisMonth: false },
  pendingBillingClaims: 0,
  tax: { enabled: false, profileStatus: null },
  chatLinked: true,
  pendingStaffInvites: 0,
  awaitingInstapayOrders: 0,
  failedPaymentOrders: 0,
};
const ids = (f: Partial<AttentionFacts>) => computeAttention({ ...clean, ...f }).map(i => i.id);

describe('computeAttention', () => {
  it('a healthy store has nothing to fix', () => {
    expect(computeAttention(clean)).toEqual([]);
  });

  it.each([
    ['domain_unverified', { domain: { pendingDomain: 'a.com', domainStatus: 'pending' } }],
    ['domain_unverified', { domain: { pendingDomain: 'a.com', domainStatus: 'failed' } }],
    ['email_dns_missing', { emailDomain: { id: 'd1', verifiedAt: null } }],
    [
      'gateway_connection_failed',
      { gateways: [{ provider: 'kashier', healthStatus: 'down', testOk: null }] },
    ],
    [
      'gateway_connection_failed',
      { gateways: [{ provider: 'kashier', healthStatus: 'healthy', testOk: false }] },
    ],
    [
      'gateway_untested',
      { gateways: [{ provider: 'kashier', healthStatus: 'unknown', testOk: null }] },
    ],
    ['instapay_incomplete', { instapayHasDestination: false }],
    ['no_delivery_rates', { deliveryZones: 0, deliveryAreaRates: 0 }],
    ['billing_past_due', { subscription: { status: 'past_due', overLimitThisMonth: false } }],
    ['billing_claim_pending', { pendingBillingClaims: 1 }],
    ['orders_over_limit', { subscription: { status: 'active', overLimitThisMonth: true } }],
    ['tax_not_verified', { tax: { enabled: true, profileStatus: 'none' } }],
    ['tax_not_verified', { tax: { enabled: true, profileStatus: 'rejected' } }],
    ['tax_review_pending', { tax: { enabled: false, profileStatus: 'pending' } }],
    ['chat_not_connected', { chatLinked: false }],
    ['staff_invites_pending', { pendingStaffInvites: 2 }],
    ['instapay_orders_unconfirmed', { awaitingInstapayOrders: 3 }],
    ['payments_failed', { failedPaymentOrders: 1 }],
  ] as Array<[string, Partial<AttentionFacts>]>)('%s fires', (id, facts) => {
    expect(ids(facts)).toContain(id);
  });

  it('signals turn off when the cause is fixed', () => {
    expect(ids({ domain: { pendingDomain: null, domainStatus: 'active' } })).not.toContain(
      'domain_unverified'
    );
    expect(ids({ emailDomain: { id: 'd1', verifiedAt: new Date() } })).not.toContain(
      'email_dns_missing'
    );
    expect(ids({ tax: { enabled: true, profileStatus: 'verified' } })).not.toContain(
      'tax_not_verified'
    );
    expect(ids({ instapayHasDestination: null })).not.toContain('instapay_incomplete');
  });

  it('order money signals carry their count and point at orders', () => {
    const items = computeAttention({ ...clean, awaitingInstapayOrders: 4, failedPaymentOrders: 2 });
    const byId = Object.fromEntries(items.map(i => [i.id, i]));
    expect(byId.instapay_orders_unconfirmed).toMatchObject({
      section: 'orders',
      count: 4,
      severity: 'action',
    });
    expect(byId.payments_failed).toMatchObject({ section: 'orders', count: 2, severity: 'action' });
  });

  it('a brand-new store with no products is not told to add delivery rates', () => {
    expect(ids({ products: 0, deliveryZones: 0, deliveryAreaRates: 0 })).not.toContain(
      'no_delivery_rates'
    );
  });
  it('area rates alone count as delivery rates', () => {
    expect(ids({ deliveryZones: 0, deliveryAreaRates: 2 })).not.toContain('no_delivery_rates');
  });

  it('plan-gated features never show as problems', () => {
    const off = { tax: false, whatsapp: false, staffAccounts: false };
    const got = ids({
      features: off,
      tax: { enabled: true, profileStatus: 'none' },
      chatLinked: false,
      pendingStaffInvites: 3,
    });
    expect(got).toEqual([]);
  });

  it('action count only counts action-needed items; info never badges', () => {
    const items = computeAttention({
      ...clean,
      emailDomain: { id: 'd1', verifiedAt: null }, // info
      pendingBillingClaims: 1, // info
      instapayHasDestination: false, // action
      subscription: { status: 'past_due', overLimitThisMonth: false }, // action
    });
    expect(countActionItems(items)).toBe(2);
    expect(actionCountsBySection(items)).toEqual({ 'payment-settings': 1, billing: 1 });
  });

  it('every item has ar + en text and a known id', () => {
    const all = computeAttention({
      features: clean.features,
      domain: { pendingDomain: 'a.com', domainStatus: 'pending' },
      emailDomain: { id: 'd', verifiedAt: null },
      gateways: [
        { provider: 'p', healthStatus: 'down', testOk: false },
        { provider: 'q', healthStatus: 'unknown', testOk: null },
      ],
      instapayHasDestination: false,
      products: 1,
      deliveryZones: 0,
      deliveryAreaRates: 0,
      subscription: { status: 'past_due', overLimitThisMonth: true },
      pendingBillingClaims: 1,
      tax: { enabled: true, profileStatus: 'none' },
      chatLinked: false,
      pendingStaffInvites: 1,
      awaitingInstapayOrders: 2,
      failedPaymentOrders: 1,
    });
    for (const i of all) {
      expect(ATTENTION_IDS).toContain(i.id);
      expect(i.title.ar && i.title.en && i.message.ar && i.message.en).toBeTruthy();
      expect(i.message.ar).toMatch(/[؀-ۿ]/);
    }
  });
});
