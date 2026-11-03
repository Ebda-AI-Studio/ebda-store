/**
 * SHARIA-GOLD-1: the server refuses COD / BNPL on gold unless the store allows it; and every order and
 * payment entry point actually calls the check (a hidden checkout option is never the enforcement).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
vi.mock('../../apps/api/src/middleware/error-handler', () => ({
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public code: string,
      message: string
    ) {
      super(message);
    }
  },
}));

import { assertGoldPaymentAllowed } from '../../apps/api/src/services/gold-rate/payment-policy';

const SRC = path.resolve(__dirname, '../../apps/api/src');
const read = (p: string) => readFileSync(path.join(SRC, p), 'utf8');

const call = (o: Parameters<typeof assertGoldPaymentAllowed>[0]) => () =>
  assertGoldPaymentAllowed(o);

describe('assertGoldPaymentAllowed', () => {
  it('gold + COD: rejected when the setting is OFF (absent), accepted when ON', () => {
    expect(call({ hasGold: true, storeSettings: {}, provider: 'cod' })).toThrow(/paid in full/);
    expect(call({ hasGold: true, storeSettings: null, provider: 'cod' })).toThrow();
    try {
      call({ hasGold: true, storeSettings: {}, provider: 'cod' })();
    } catch (e) {
      expect((e as { code: string; statusCode?: number }).code).toBe('GOLD_PREPAID_ONLY');
    }
    expect(
      call({ hasGold: true, storeSettings: { goldAllowDeferredPayment: true }, provider: 'cod' })
    ).not.toThrow();
  });

  it('gold + BNPL: rejected when OFF, accepted when ON', () => {
    for (const method of ['valu', 'kiosk', 'bnpl']) {
      expect(call({ hasGold: true, storeSettings: {}, provider: 'paymob', method })).toThrow();
      expect(
        call({
          hasGold: true,
          storeSettings: { goldAllowDeferredPayment: true },
          provider: 'paymob',
          method,
        })
      ).not.toThrow();
    }
  });

  it('a cart without gold is unchanged', () => {
    for (const settings of [{}, { goldAllowDeferredPayment: true }])
      for (const [provider, method] of [
        ['cod', undefined],
        ['paymob', 'valu'],
        ['paymob', 'card'],
      ] as const)
        expect(call({ hasGold: false, storeSettings: settings, provider, method })).not.toThrow();
  });
});

describe('every entry point calls the gold payment check', () => {
  it('OrderService.create and createAdminOrder', () => {
    const src = read('services/order.service.ts');
    expect((src.match(/assertGoldPaymentAllowed\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it('POST /payments/create', () => {
    expect(read('routes/payment.routes.ts')).toMatch(/assertGoldPaymentAllowed\(/);
  });
});

describe('gateway pages leave installments out of a prepaid-only order', () => {
  it('Kashier allowedMethods drops bnpl only when excluded; never empty', async () => {
    const { allowedMethodsFor } =
      await import('../../apps/api/src/services/payment-providers/kashier.provider');
    expect(allowedMethodsFor(['card', 'wallet', 'bnpl'], false)).toBe('card,wallet,bnpl');
    expect(allowedMethodsFor(['card', 'wallet', 'bnpl'], true)).toBe('card,wallet');
    expect(allowedMethodsFor(['bnpl'], true)).toBe('card,wallet');
  });
  it('Paymob drops the valu + kiosk integrations when excludeBnpl is set', () => {
    const src = read('services/payment-providers/paymob.provider.ts');
    expect(src).toMatch(/excludeBnpl === 'true' \? \['valu', 'kiosk'\]/);
  });
  it('/payments/config tells the storefront (goldPrepaidOnly), default true', () => {
    expect(read('routes/payment.routes.ts')).toMatch(/goldPrepaidOnly/);
  });
});

describe('the switch is written only by its own audited route', () => {
  it('is a server-owned settings key, and the PUT needs confirm to turn ON', async () => {
    const { SERVER_OWNED_SETTINGS_KEYS } = await import('@ebda/shared');
    expect(SERVER_OWNED_SETTINGS_KEYS).toContain('goldAllowDeferredPayment');
    const routes = read('routes/gold-rate.routes.ts');
    expect(routes).toMatch(/CONFIRM_REQUIRED/);
    expect(routes).toMatch(/store\.gold_allow_deferred_payment/);
  });
});

describe('storefront checkout hides deferred options on a gold cart', () => {
  it('cod and installment option ids are deferred; card, wallet, instapay, kashier are not', async () => {
    const { isDeferredGoldOption } = await import('../../apps/web/src/lib/gold-display');
    for (const id of ['cod', 'paymob:valu', 'paymob:kiosk'])
      expect(isDeferredGoldOption(id)).toBe(true);
    for (const id of ['paymob:card', 'paymob:wallet', 'instapay', 'kashier', 'fawry:payatfawry'])
      expect(isDeferredGoldOption(id)).toBe(false);
  });
});
