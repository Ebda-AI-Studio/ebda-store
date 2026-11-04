import { describe, expect, it } from 'vitest';
import {
  BNPL_DISCLOSURE,
  GOLD_DEFERRED_EXPLANATION,
  checkGoldPayment,
  goldAllowsDeferredPayment,
  isBnplMethod,
  settingsEnableBnpl,
} from '../commerce/payment-policy';

describe('gold payment policy (SHARIA-GOLD-1)', () => {
  it('a cart without gold is never restricted', () => {
    for (const provider of ['cod', 'paymob', 'instapay'])
      expect(checkGoldPayment({ hasGold: false, allowDeferred: false, provider })).toEqual({
        ok: true,
      });
    expect(
      checkGoldPayment({ hasGold: false, allowDeferred: false, provider: 'paymob', method: 'valu' })
    ).toEqual({ ok: true });
  });

  it('gold + COD is refused while the switch is off and accepted when on', () => {
    expect(checkGoldPayment({ hasGold: true, allowDeferred: false, provider: 'cod' })).toEqual({
      ok: false,
      code: 'GOLD_PREPAID_ONLY',
    });
    expect(checkGoldPayment({ hasGold: true, allowDeferred: true, provider: 'cod' })).toEqual({
      ok: true,
    });
  });

  it('gold + BNPL (valu, kiosk, bnpl) is refused while off and accepted when on', () => {
    for (const method of ['valu', 'kiosk', 'bnpl', 'VALU']) {
      expect(
        checkGoldPayment({ hasGold: true, allowDeferred: false, provider: 'paymob', method })
      ).toEqual({ ok: false, code: 'GOLD_PREPAID_ONLY' });
      expect(
        checkGoldPayment({ hasGold: true, allowDeferred: true, provider: 'paymob', method })
      ).toEqual({ ok: true });
    }
  });

  it('gold + prepaid online methods stay allowed', () => {
    for (const [provider, method] of [
      ['paymob', 'card'],
      ['paymob', 'wallet'],
      ['kashier', undefined],
      ['instapay', undefined],
      ['fawry', 'card'],
      ['fawry', undefined], // method unknown at order creation; /payments/create checks it
    ] as const)
      expect(checkGoldPayment({ hasGold: true, allowDeferred: false, provider, method })).toEqual({
        ok: true,
      });
  });

  it('gold + a pay-later reference (Pay at Fawry) is refused: gold is paid at the contract, never at an outlet later', () => {
    for (const [provider, method] of [
      ['fawry', 'payatfawry'],
      ['fawry', 'PAYATFAWRY'],
      ['payatfawry', undefined],
    ] as const) {
      expect(checkGoldPayment({ hasGold: true, allowDeferred: false, provider, method })).toEqual({
        ok: false,
        code: 'GOLD_PREPAID_ONLY',
      });
      expect(checkGoldPayment({ hasGold: true, allowDeferred: true, provider, method })).toEqual({
        ok: true,
      });
    }
  });

  it('checks BOTH fields: a COD method behind an online provider is still COD', () => {
    expect(
      checkGoldPayment({ hasGold: true, allowDeferred: false, provider: 'paymob', method: 'cod' })
    ).toEqual({ ok: false, code: 'GOLD_PREPAID_ONLY' });
    expect(
      checkGoldPayment({ hasGold: true, allowDeferred: false, provider: 'cod', method: 'card' })
    ).toEqual({ ok: false, code: 'GOLD_PREPAID_ONLY' });
  });

  it('only a literal true turns the setting on (default OFF)', () => {
    expect(goldAllowsDeferredPayment(undefined)).toBe(false);
    expect(goldAllowsDeferredPayment({})).toBe(false);
    expect(goldAllowsDeferredPayment({ goldAllowDeferredPayment: 'true' })).toBe(false);
    expect(goldAllowsDeferredPayment({ goldAllowDeferredPayment: true })).toBe(true);
  });

  it('the explanation is Egyptian Arabic + English', () => {
    expect(GOLD_DEFERRED_EXPLANATION.ar).toMatch(/[؀-ۿ]/);
    expect(GOLD_DEFERRED_EXPLANATION.en.length).toBeGreaterThan(20);
  });
});

describe('BNPL defaults and disclosure (SHARIA-BNPL-1)', () => {
  it('knows the installment codes', () => {
    expect(isBnplMethod('valu') && isBnplMethod('kiosk') && isBnplMethod('bnpl')).toBe(true);
    expect(isBnplMethod('card')).toBe(false);
  });

  it('a fresh store config offers no installment provider', () => {
    expect(settingsEnableBnpl('paymob', {})).toBe(false);
    expect(settingsEnableBnpl('paymob', { integrationIds: { card: 1, wallet: 2 } })).toBe(false);
    expect(settingsEnableBnpl('kashier', { methods: ['card', 'wallet'] })).toBe(false);
    expect(settingsEnableBnpl('paymob', { integrationIds: { valu: 7 } })).toBe(true);
    expect(settingsEnableBnpl('paymob', { integrationIds: { kiosk: 7 } })).toBe(true);
    expect(settingsEnableBnpl('kashier', { methods: ['card', 'bnpl'] })).toBe(true);
  });

  it('the disclosure says the provider terms and fees apply, in both languages', () => {
    expect(BNPL_DISCLOSURE.en).toMatch(/terms/i);
    expect(BNPL_DISCLOSURE.en).toMatch(/fees/i);
    expect(BNPL_DISCLOSURE.ar).toMatch(/شروط/);
  });
});
