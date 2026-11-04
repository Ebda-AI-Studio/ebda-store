/**
 * Sharia payment policy (Rulings SHARIA-GOLD-1, SHARIA-BNPL-1; Ahmad 2026-11-03).
 *
 * Pure rules shared by the API (the only place they are ENFORCED), the storefront checkout (hides the
 * options) and the admin (the merchant switch and the BNPL disclosure). Gold sold for money is paid in
 * full at the time of sale, so an order with a gold line is prepaid online by default: cash on delivery
 * and installment (BNPL) methods are refused unless the merchant has switched the store setting on.
 */

/** Customer-facing installment (BNPL) method codes across the catalog: Paymob valU + Kiosk, Kashier bnpl. */
export const BNPL_METHOD_CODES = ['valu', 'kiosk', 'bnpl'] as const;
export type BnplMethodCode = (typeof BNPL_METHOD_CODES)[number];

/** Pay-later-at-an-outlet codes outside BNPL: the Fawry reference (`payatfawry`) is cash at a Fawry outlet after the sale. */
export const PAY_LATER_REFERENCE_CODES = ['payatfawry'] as const;

export function isBnplMethod(method: string | null | undefined): boolean {
  return (BNPL_METHOD_CODES as readonly string[]).includes(String(method ?? '').toLowerCase());
}

/** `store.settings` key of the merchant's switch (absent or anything but `true` = prepaid only). */
export const GOLD_ALLOW_DEFERRED_SETTING = 'goldAllowDeferredPayment';

/** Reads the switch from a `store.settings` blob. Only a literal `true` turns it on. */
export function goldAllowsDeferredPayment(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false;
  return (settings as Record<string, unknown>)[GOLD_ALLOW_DEFERRED_SETTING] === true;
}

export const GOLD_PREPAID_ERROR_CODE = 'GOLD_PREPAID_ONLY';

export const GOLD_PREPAID_MESSAGE = {
  en: 'Orders with gold are paid in full online. Cash on delivery and installments are not available for gold.',
  ar: 'طلبات الدهب بتتدفع كاملة أونلاين. الدفع عند الاستلام والتقسيط مش متاحين للدهب.',
} as const;

/** Shown (ar/en) next to the merchant switch; turning it ON needs an explicit confirm. */
export const GOLD_DEFERRED_EXPLANATION = {
  en: 'Gold bought for money is normally paid in full at the time of sale. If you allow cash on delivery or installments for gold, you take responsibility for that choice.',
  ar: 'الدهب لما بيتباع بالفلوس بيتدفع كامل وقت البيع في الأصل. لو سمحت بالدفع عند الاستلام أو التقسيط للدهب، القرار ده مسؤوليتك.',
} as const;

export type GoldPaymentVerdict = { ok: true } | { ok: false; code: typeof GOLD_PREPAID_ERROR_CODE };

/**
 * Whether `provider` (+ optional gateway `method`) may be used for an order. `provider` is the order's
 * payment method or the payment provider (`cod`, `instapay`, `paymob`, ...). Online card / wallet /
 * InstaPay / Fawry CARD pay now and stay allowed; COD, any BNPL method and a pay-later reference (Paymob
 * kiosk, Pay at Fawry: cash at an outlet after the sale) defer payment and are refused on gold unless the
 * store allows it. BOTH `provider` and `method` are checked, so `{cod, paymob}` cannot slip past on the provider. An order without gold is never restricted by this rule.
 */
export function checkGoldPayment(input: {
  hasGold: boolean;
  allowDeferred: boolean;
  provider?: string | null;
  method?: string | null;
}): GoldPaymentVerdict {
  if (!input.hasGold || input.allowDeferred) return { ok: true };
  const deferredCode = (raw: string | null | undefined): boolean => {
    const code = String(raw ?? '').toLowerCase();
    return (
      code === 'cod' ||
      code === 'cash' ||
      code === 'cash_on_delivery' ||
      isBnplMethod(code) ||
      (PAY_LATER_REFERENCE_CODES as readonly string[]).includes(code)
    );
  };
  const deferred = deferredCode(input.provider) || deferredCode(input.method);
  return deferred ? { ok: false, code: GOLD_PREPAID_ERROR_CODE } : { ok: true };
}

/** Shown when a merchant enables an installment provider: the provider's own terms and fees apply to the customer. */
export const BNPL_DISCLOSURE = {
  en: 'Installments are financed by the provider (valU, Kashier, Aman, Masary), not by Ebda. The provider own terms, fees and any late charges apply to your customer. Check them before you turn this on.',
  ar: 'التقسيط بيتموله مزوّد الخدمة (فاليو، كاشير، أمان، مصاري) مش ابدأ. شروط المزوّد ورسومه وأي غرامات تأخير بتتطبق على عميلك. راجعها قبل ما تفعّل الخدمة دي.',
} as const;

/** The setting names that switch an installment method on: Paymob integration ids and Kashier methods. */
export function settingsEnableBnpl(provider: string, settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const s = settings as { integrationIds?: Record<string, unknown>; methods?: unknown };
  if (provider === 'paymob') {
    const ids = s.integrationIds ?? {};
    return typeof ids.valu === 'number' || typeof ids.kiosk === 'number';
  }
  if (provider === 'kashier') {
    return Array.isArray(s.methods) && s.methods.some(m => m === 'bnpl');
  }
  return false;
}
