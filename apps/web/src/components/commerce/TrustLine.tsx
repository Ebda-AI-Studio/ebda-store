'use client';

/**
 * One trust line under the PDP buy button (S-02, quality-bar § 8):
 * "الدفع عند الاستلام · إرجاع خلال ١٤ يوم". Egyptian shoppers decide on COD and
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
    // Audit 2026-11-03 #13: 12 px grey was the only trust cue. Body size, the ink token (>= 4.5:1
    // on every ground), a check mark, and room to wrap: it is a reason to buy, not a footnote.
    <p
      data-testid="pdp-trust-line"
      className={`${className} flex flex-wrap items-center gap-x-1 text-base leading-6 text-foreground`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="me-1 h-4 w-4 shrink-0 text-muted-foreground"
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
      {cod && <span data-trust="cod">{cod}</span>}
      {cod && returns && <span aria-hidden="true"> · </span>}
      {returns && (
        <a
          data-trust="returns"
          href={storeUrl('/returns')}
          className="relative underline underline-offset-4 before:absolute before:-inset-y-4 before:inset-x-0 before:content-[''] hover:text-foreground"
        >
          {returns}
        </a>
      )}
    </p>
  );
}
