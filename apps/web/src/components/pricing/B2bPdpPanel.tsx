'use client';

/**
 * PDP wholesale panel (B2B Task 6): the minimum order quantity, the PUBLIC price-break table, and (signed-in buyers only) the
 * buyer's own prices painted AFTER mount from `POST /public/pricing/resolve` (private, no-store). The server-rendered HTML
 * therefore contains retail / public data only; nothing buyer-specific is ever in a cacheable response.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useOptionalAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { tierRows, resolveQuantities, buyerPricesByQty, type PublicTier } from '@/lib/b2b-tiers';

export function B2bPdpPanel({
  productId,
  variantId,
  moq,
  tiers,
}: {
  productId: string;
  variantId?: string | null;
  moq?: number | null;
  tiers?: PublicTier[] | null;
}) {
  const { t } = useLanguage();
  const formatPrice = useLocalePrice();
  const isAuthenticated = useOptionalAuth()?.isAuthenticated ?? false;
  const rows = useMemo(() => tierRows(tiers ?? [], variantId), [tiers, variantId]);
  const [mine, setMine] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    setMine(new Map());
    if (!isAuthenticated) return;
    let cancelled = false;
    const qtys = resolveQuantities(rows);
    void api
      .resolvePrices(qtys.map(qty => ({ productId, variantId: variantId ?? null, qty })))
      .then(res => {
        if (!cancelled && res.success && res.data) setMine(buyerPricesByQty(res.data.prices));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, productId, variantId, rows]);

  if (!moq && rows.length === 0 && mine.size === 0) return null;
  const yours = mine.get(1);
  return (
    <div className="mt-3 rounded-lg border bg-muted/30 p-3 text-sm" data-testid="b2b-pdp-panel">
      {moq ? (
        <p className="font-medium">
          {t(`Minimum order: ${moq} units`, `الحد الأدنى للطلب: ${moq} وحدة`)}
        </p>
      ) : null}
      {yours !== undefined ? (
        <p className="mt-1 font-semibold text-primary">
          {t('Your wholesale price', 'سعر الجملة بتاعك')}: {formatPrice(yours)}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <table className="mt-2 w-full text-start">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="py-1 text-start font-normal">{t('Quantity', 'الكمية')}</th>
              <th className="py-1 text-start font-normal">{t('Price per unit', 'سعر الوحدة')}</th>
              {mine.size > 0 ? (
                <th className="py-1 text-start font-normal">{t('Your price', 'سعرك')}</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.minQty}>
                <td className="py-0.5">{t(`${r.minQty}+ units`, `${r.minQty}+ وحدة`)}</td>
                <td className="py-0.5">{formatPrice(r.priceMinor)}</td>
                {mine.size > 0 ? (
                  <td className="py-0.5 font-medium">
                    {mine.has(r.minQty) ? formatPrice(mine.get(r.minQty)!) : '-'}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
