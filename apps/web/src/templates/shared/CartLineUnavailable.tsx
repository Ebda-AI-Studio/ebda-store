'use client';

import { useLanguage } from '../../contexts/LanguageContext';

/**
 * #1766 — marks a cart line whose product the merchant has deleted. The line
 * stays listed so the shopper can remove it, but it is excluded from the cart
 * total and the server refuses checkout while it remains, so every CartTable
 * (every template's cart table) and CartClient's default list render this under the name.
 */
export function CartLineUnavailableNotice() {
  const { t } = useLanguage();
  return (
    <p
      role="status"
      data-cart-line-unavailable=""
      className="mt-1 text-xs font-semibold text-destructive-ink"
    >
      {t('No longer available — remove it to check out', 'مبقاش متوفر — شيله عشان تكمّل الطلب')}
    </p>
  );
}
