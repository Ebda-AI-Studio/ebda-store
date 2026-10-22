'use client';

/**
 * "Order again" (Phase B4, Lamma; Ruling B4-8): a product row of what THIS customer bought
 * lately, for `productSource: 'reorder'` on a product carousel or a featured collection.
 *
 * Anonymous shoppers, customers with no paid orders, and a failed request render NOTHING (no
 * placeholder, no wrapper: an unfilled feature renders nothing). The id list comes from the
 * per-customer, never-cached endpoint; current name, price and availability then come from the
 * same public product read every listing uses, and only what `canBuyNow` is kept, so a product
 * that sold out or was unpublished since drops out. The card is the shared carousel card with the
 * shared stepper; the add itself re-checks stock server-side. Mounts after hydration, so the
 * page must place it below the first screen (CLS).
 */
import React, { useEffect, useState } from 'react';
import type { TemplateId } from '@ebda/shared';
import { api, type Product } from '@/lib/api';
import { useOptionalAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { canBuyNow } from '../../lib/can-buy-now';
import { toTemplateProduct } from '../../templates/adapters';
import { ProductCarousel } from '../../templates/shared/ProductCarousel';
import type { TemplateProduct } from '../../templates/types';

/** Keep the customer's order, drop what is gone or cannot be bought now. Pure, for tests. */
export function orderedBuyable(ids: readonly string[], products: readonly Product[]): Product[] {
  const byId = new Map(products.map(p => [p.id, p]));
  return ids
    .map(id => byId.get(id))
    .filter(
      (p): p is Product => !!p && (p as { status?: string }).status !== 'archived' && canBuyNow(p)
    );
}

export function ReorderRow({
  title,
  titleAr,
  limit,
  pack,
  onAddToCart,
  sectionProps,
}: {
  title?: string;
  titleAr?: string;
  limit?: number;
  pack: TemplateId;
  onAddToCart: (productId: string) => Promise<void>;
  /** The wrapping <section> the page gives every row (spacing classes, background, data attribute). */
  sectionProps: React.HTMLAttributes<HTMLElement> & Record<string, unknown>;
}) {
  const auth = useOptionalAuth();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { isRtl, t } = useLanguage();
  const [products, setProducts] = useState<TemplateProduct[] | null>(null);
  const signedIn = !!auth?.isAuthenticated && !!auth.user;

  useEffect(() => {
    if (!signedIn) {
      setProducts(null);
      return;
    }
    let live = true;
    (async () => {
      try {
        const idsRes = await api.getReorderProductIds();
        const ids = idsRes.success ? (idsRes.data?.productIds ?? []) : [];
        if (ids.length === 0) return live && setProducts(null);
        const listRes = await api.getProducts({ ids: ids.join(','), limit: String(ids.length) });
        const list = listRes.success ? (listRes.data?.products ?? []) : [];
        const row = orderedBuyable(ids, list)
          .slice(0, limit ?? 12)
          .map(toTemplateProduct);
        if (live) setProducts(row.length > 0 ? row : null);
      } catch {
        if (live) setProducts(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [signedIn, limit]);

  if (!signedIn || !products || products.length === 0) return null;
  return (
    <section data-section="reorder" {...sectionProps}>
      <ProductCarousel
        urlPrefix={storeUrl('')}
        products={products}
        title={title || t('Order again', 'اطلب تاني')}
        titleAr={titleAr || 'اطلب تاني'}
        isRtl={isRtl}
        currency={store.currency}
        onAddToCart={onAddToCart}
        pack={pack}
      />
    </section>
  );
}
