/**
 * "We Accept" badges for the cart page, derived from the store's ACTUAL
 * `/payments/config` response — never a static guess.
 *
 * Bug: a COD-only store (no Paymob/Kashier configured) showed Visa,
 * Mastercard, Meeza and Fawry marks regardless, because the cart fell back
 * to a hardcoded list whenever `store.settings.acceptedPaymentMethods` was
 * unset (true for most stores — it's a rarely-touched override). The
 * checkout's own payment-method picker (`PaymentStep`) already refuses to do
 * this ("that list was a visual mock and showed payment options the backend
 * would 400 on"); the cart page is the same defect class fixed the same way.
 */

export interface PaymentConfigResponse {
  providers?: unknown;
  cod?: { displayName?: string; displayNameAr?: string } | null;
  instapay?: { displayName?: string; displayNameAr?: string } | null;
}

export interface PaymentBadge {
  label: string;
  labelAr: string;
}

/** Online gateways that put a real card/wallet form in front of the customer. */
const CARD_PROVIDERS = new Set(['paymob', 'kashier']);

export function deriveAcceptedPaymentBadges(config: PaymentConfigResponse): PaymentBadge[] {
  const badges: PaymentBadge[] = [];
  const providers = Array.isArray(config.providers)
    ? config.providers.filter((p): p is string => typeof p === 'string')
    : [];

  if (providers.some(p => CARD_PROVIDERS.has(p))) badges.push({ label: 'Card', labelAr: 'بطاقة' });
  if (providers.includes('fawry')) badges.push({ label: 'Pay at Fawry', labelAr: 'ادفع في فوري' });
  if (config.cod)
    badges.push({
      label: config.cod.displayName || 'Cash on Delivery',
      labelAr: config.cod.displayNameAr || 'الدفع عند الاستلام',
    });
  if (config.instapay)
    badges.push({
      label: config.instapay.displayName || 'InstaPay',
      labelAr: config.instapay.displayNameAr || 'إنستاباي',
    });
  return badges;
}
