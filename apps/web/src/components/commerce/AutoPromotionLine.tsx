'use client';

/**
 * PDP automatic-promotion line: "عرض تلقائي: خصم 15 ج.م على اللي في السلة" is the same offer the cart and
 * checkout show. The amount is the SERVER's (POST promotions/preview, the resolver order creation uses),
 * never recomputed here. Renders nothing without an applicable promotion.
 *
 * CACHE CLASS: NEVER-stale for money; nothing is cached, it re-asks per product / quantity.
 */
import { useStore } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { useAutoPromotionPreview } from '../../hooks/useAutoPromotionPreview';

export function AutoPromotionLine({
  productId,
  quantity = 1,
}: {
  productId: string;
  quantity?: number;
}) {
  const { store } = useStore();
  const { t } = useLanguage();
  const formatPrice = useLocalePrice();
  const enabled = !!store.id && store.id !== 'demo';
  const promotion = useAutoPromotionPreview(
    enabled ? store.id : undefined,
    enabled ? [{ productId, quantity }] : []
  );
  if (!promotion || promotion.discount <= 0) return null;
  const amount = formatPrice(promotion.discount);
  return (
    <p data-testid="pdp-auto-promotion" className="mt-2 text-sm font-medium text-success-ink">
      {t(`Automatic offer: ${amount} off at checkout`, `عرض تلقائي: خصم ${amount} عند إتمام الطلب`)}
    </p>
  );
}
