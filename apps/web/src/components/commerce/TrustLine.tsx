'use client';

/**
 * One trust line under the PDP buy button (S-02, quality-bar § 8):
 * "الدفع عند الاستلام · إرجاع خلال ١٤ يومًا". Egyptian shoppers decide on COD and
 * the return window, and neither was near the CTA.
 *
 * Both halves come from the store, nothing is hard-coded:
 *  - COD: the store's own `/payments/config` says COD is on (its display name
 *    is the merchant's; unknown or off = no COD part);
 *  - returns: `store.returnWindowDays` > 0 (0 = not accepted and undeclared are
 *    not advertised here; the /returns page explains them). It links there.
 * With neither, nothing renders (no empty state).
 */
import { useLanguage } from '@/contexts/LanguageContext';
import { useStore, useStoreUrl } from '@/contexts/StoreContext';
import { useNumerals } from '@/hooks/useNumerals';
import { useStorePaymentConfig } from '@/hooks/useStorePaymentConfig';
import { countText, DAYS } from '@/lib/plural';
import { returnPolicyKind } from '@/lib/return-policy-text';

export function TrustLine({ className = 'mt-3' }: { className?: string }) {
  const { language, t } = useLanguage();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { localize } = useNumerals();
  const payment = useStorePaymentConfig();

  const ar = language === 'ar';
  const cod = payment?.cod
    ? ar
      ? payment.cod.displayNameAr?.trim() || 'الدفع عند الاستلام'
      : payment.cod.displayName?.trim() || 'Cash on delivery'
    : null;
  const days = store.returnWindowDays;
  const returns =
    returnPolicyKind(days) === 'window'
      ? t(
          `Returns within ${countText('en', days as number, DAYS)}`,
          `إرجاع خلال ${countText('ar', days as number, DAYS, localize(days as number))}`
        )
      : null;
  if (!cod && !returns) return null;

  return (
    <p data-testid="pdp-trust-line" className={`${className} text-sm text-muted-foreground`}>
      {cod && <span data-trust="cod">{cod}</span>}
      {cod && returns && <span aria-hidden="true"> · </span>}
      {returns && (
        <a
          data-trust="returns"
          href={storeUrl('/returns')}
          className="underline-offset-4 hover:text-foreground hover:underline"
        >
          {returns}
        </a>
      )}
    </p>
  );
}
