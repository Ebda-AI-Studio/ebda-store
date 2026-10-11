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
 *
 * Reads the SPECIFIC enabled methods (`config.methods`, keyed by provider —
 * same shape `apps/api/src/routes/payment.routes.ts`'s `loadCheckoutPaymentConfig`
 * builds from `enabledMethods()`/`METHOD_LABELS`), not just which providers
 * are turned on: a merchant who only enabled Meeza on Paymob (common in
 * Egypt — cheaper fees than a full card gateway) gets a "Meeza" badge, not a
 * generic "Card" one that overclaims a capability they didn't turn on.
 */

export interface PaymentMethodEntry {
  code: string;
  name?: string;
  nameAr?: string;
}

export interface PaymentConfigResponse {
  methods?: Record<string, PaymentMethodEntry[]>;
  cod?: { displayName?: string | null; displayNameAr?: string | null } | null;
  instapay?: { displayName?: string | null; displayNameAr?: string | null } | null;
}

export interface PaymentBadge {
  label: string;
  labelAr: string;
}

/** Mirrors `METHOD_LABELS` in `apps/api/src/services/payment-providers/provider-methods.ts`. */
const METHOD_BADGES: Record<string, PaymentBadge> = {
  card: { label: 'Card', labelAr: 'بطاقة' },
  meeza: { label: 'Meeza', labelAr: 'ميزة' },
  wallet: { label: 'Mobile wallet', labelAr: 'محفظة إلكترونية' },
  valu: { label: 'valU installments', labelAr: 'تقسيط فاليو' },
  payatfawry: { label: 'Pay at Fawry', labelAr: 'ادفع في فوري' },
};

export function deriveAcceptedPaymentBadges(config: PaymentConfigResponse): PaymentBadge[] {
  const badges: PaymentBadge[] = [];
  const seen = new Set<string>();
  const methodsByProvider =
    config.methods && typeof config.methods === 'object' ? config.methods : {};

  for (const entries of Object.values(methodsByProvider)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const code = entry?.code;
      if (typeof code !== 'string' || seen.has(code)) continue;
      const badge = Object.prototype.hasOwnProperty.call(METHOD_BADGES, code)
        ? METHOD_BADGES[code]
        : undefined;
      if (!badge) continue; // unknown/future code — never guess a label
      seen.add(code);
      badges.push(badge);
    }
  }

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
