/** "Needs attention": every signal on and off, plan-gated signals never fire, action count. */
import { describe, it, expect } from 'vitest';
import { computeAttention, type AttentionFacts } from '../../apps/api/src/services/attention.rules';
import { ATTENTION_IDS, countActionItems, actionCountsBySection } from '@ebda/shared';

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
    });
    for (const i of all) {
      expect(ATTENTION_IDS).toContain(i.id);
      expect(i.title.ar && i.title.en && i.message.ar && i.message.en).toBeTruthy();
      expect(i.message.ar).toMatch(/[؀-ۿ]/);
    }
  });
});
