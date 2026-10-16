'use client';

/**
 * One trust line under the PDP buy button (S-02, quality-bar § 8):
 * "الدفع عند الاستلام · إرجاع خلال ١٤ يومًا". Egyptian shoppers decide on COD and
 * the return window, and neither was near the CTA.
 *
 * Both halves come from the store, nothing is hard-coded:
 *  - COD: the store's own `/payments/config`, read on the server while the PDP
 *    renders (`fetchCodOffer`) and passed in, so the line is in the first paint
 *    and never inserted after load (review I5: zero layout shift). The display
 *    name is the merchant's; unknown or off = no COD part;
 *  - returns: `store.returnWindowDays` > 0 (0 = not accepted and undeclared are
 *    not advertised here; the /returns page explains them). It links there.
 * With neither, nothing renders (no empty state).
 */
import { useLanguage } from '@/contexts/LanguageContext';
import { useStore, useStoreUrl } from '@/contexts/StoreContext';
import { useNumerals } from '@/hooks/useNumerals';
import type { CodOffer } from '@/lib/cod-offer';
import { daysPhrase, returnPolicyKind } from '@/lib/return-policy-text';

export function TrustLine({
  cod: codOffer,
  className = 'mt-3',
}: {
  cod: CodOffer | null | undefined;
  className?: string;
}) {
  const { language, t } = useLanguage();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { localize } = useNumerals();

  const ar = language === 'ar';
  const cod = codOffer
    ? ar
      ? codOffer.nameAr || 'الدفع عند الاستلام'
      : codOffer.name || 'Cash on delivery'
    : null;
  const days = store.returnWindowDays;
  const returns =
    returnPolicyKind(days) === 'window'
      ? t(
          `Returns within ${daysPhrase(days as number, 'en')}`,
          // the same phrase (and digits) /returns prints (review M8)
          `إرجاع خلال ${daysPhrase(days as number, 'ar', localize)}`
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
