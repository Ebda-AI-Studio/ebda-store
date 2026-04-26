'use client';

import { useStore } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';

/**
 * Small "Includes VAT" badge rendered under the price when the store has
 * configured `taxIncludedInPrice = true`. When tax is *exclusive* (the
 * default) the storefront stays silent — tax is added separately at
 * checkout and the breakdown is shown on the cart/order summary.
 *
 * Returns `null` when:
 * - the store has no tax setup at all, or
 * - tax is enabled but exclusive (no copy needed because checkout will
 *   show the tax line item).
 *
 * Kept tiny on purpose so each template's ProductCard can drop it under
 * the price without disturbing layout.
 */
interface TaxInclusiveLabelProps {
  /** Optional className override so each template can match its own
   *  typography (e.g. Elegant uses tracking-wide uppercase). */
  className?: string;
}

export function TaxInclusiveLabel({ className }: TaxInclusiveLabelProps) {
  const { store } = useStore();
  const { t } = useLanguage();

  // Only render the marketing-correctness signal when prices already include
  // VAT. Stores that compute tax on top of the listed price don't need the
  // copy here — the cart shows the breakdown.
  if (!store.taxIncludedInPrice) return null;

  return (
    <span className={className ?? 'text-xs text-muted-foreground'}>
      {t('Includes VAT', 'شامل ضريبة القيمة المضافة')}
    </span>
  );
}
